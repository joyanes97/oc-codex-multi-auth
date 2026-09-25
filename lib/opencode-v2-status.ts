import { getCodexTuiMaskEmail, getCodexTuiMaskEmailInQuotaDetails, getQuotaDisplay, getQuotaStatus, loadPluginConfig } from "./config.js";
import { fetchTuiQuotaOverview, toQuotaOverviewAccounts } from "./tui-quota-overview.js";
import { readTuiQuotaSnapshot, readTuiQuotaOverviewSnapshot, isFreshTuiQuotaSnapshot, TUI_QUOTA_OVERVIEW_CACHE_FILE } from "./tui-quota-cache.js";
import { formatPromptStatusText, formatQuotaDetailsText, formatQuotaOverviewStatusLines, formatQuotaResetsStatusLines, type CompactQuotaStatus } from "./tui-status.js";
import { dirname, join } from "node:path";
import { getStoragePath, loadAccounts } from "./storage.js";
import { createUsageAccountFingerprint } from "./codex-usage.js";
import { resolveDisplayEmail } from "./account-display.js";

/** Same cadence as the V1 prompt status poll. */
const OVERVIEW_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const lastOverviewAttempt = new Map<string, number>();

/** Test hook: forget when each pool was last fetched. */
export function resetV2StatusThrottle(): void {
	lastOverviewAttempt.clear();
}

/**
 * The TUI asks for status every two seconds, and a pool snapshot can stay stale
 * indefinitely (a failing account keeps its older reading and fetch time). Gate
 * the network pass on the last attempt, not the last success, so a stale cache
 * reads the file instead of re-fetching every account on every poll.
 */
async function loadPoolOverview(cachePath: string) {
	const now = Date.now();
	const last = lastOverviewAttempt.get(cachePath);
	if (last !== undefined && now - last < OVERVIEW_REFRESH_INTERVAL_MS) {
		return readTuiQuotaOverviewSnapshot(cachePath);
	}
	lastOverviewAttempt.set(cachePath, now);
	return fetchTuiQuotaOverview({ cachePath, now });
}

/** Format on the server so remote TUIs never need access to credentials. */
export async function readV2Status({ width }: { width: number }) {
	const config = loadPluginConfig();
	const status = getQuotaStatus(config);
	const quotaDisplay = getQuotaDisplay(config);
	const maskEmail = getCodexTuiMaskEmail(config);
	const snapshot = await readTuiQuotaSnapshot();
	const pool = await loadAccounts();
	const owned = snapshot && pool?.accounts.some((account) => createUsageAccountFingerprint(account) === snapshot.fingerprint);
	let quota: CompactQuotaStatus = snapshot && owned
		? { ...snapshot, type: "ready", stale: !isFreshTuiQuotaSnapshot(snapshot) }
		: { type: pool?.accounts.length ? "unavailable" : "missing" };
	const wantsPool = status.screens.some((screen) => screen !== "active");
	const overview = pool?.accounts.length && (wantsPool || quota.type !== "ready" || quota.stale)
		? await loadPoolOverview(join(dirname(getStoragePath()), TUI_QUOTA_OVERVIEW_CACHE_FILE))
		: null;
	const active = pool?.accounts[pool.activeIndex];
	const usage = active && overview?.accounts.find((account) => account.fingerprint === createUsageAccountFingerprint(active));
	if (usage && overview) {
		quota = { type: "ready", limits: usage.limits, stale: !isFreshTuiQuotaSnapshot(overview),
			source: "usage", fetchedAt: overview.fetchedAt, accountIndex: pool ? pool.activeIndex + 1 : undefined,
			accountCount: pool?.accounts.length, accountEmail: active.email, accountLabel: active.accountLabel,
			planType: usage.planType };
	}
	const activeText = formatPromptStatusText({ quota, width, quotaDisplay, maskEmail });
	const renderScreen = (screen: (typeof status.screens)[number]): string => {
		if (screen === "active" || !overview) return activeText;
		const format = screen === "resets" ? formatQuotaResetsStatusLines : formatQuotaOverviewStatusLines;
		return format({
			accounts: toQuotaOverviewAccounts(overview), width, availableChars: width, maxRows: status.rows,
			options: { ...status, names: status.accountNames, mode: quotaDisplay, maskEmail },
		}).join("\n");
	};
	// Like V1, rotate only among screens with something to say: the resets
	// screen is empty until the pool is spent and must not blank the line.
	const rendered = status.screens.map(renderScreen).filter((text) => text.length > 0);
	const text = rendered.length > 0
		? rendered[Math.floor(Date.now() / status.rotateMs) % rendered.length] ?? ""
		: "";
	return {
		text,
		accounts: (pool?.accounts ?? []).map((account, index) => ({
			index: index + 1,
			label: account.accountLabel?.trim() || resolveDisplayEmail(account.email, maskEmail) || `Account ${index + 1}`,
			active: index === pool?.activeIndex,
			enabled: account.enabled !== false,
		})),
		details: formatQuotaDetailsText(quota, Date.now(), { quotaDisplay, maskEmail: getCodexTuiMaskEmailInQuotaDetails(config) }),
		showFor: status.showFor,
	};
}
