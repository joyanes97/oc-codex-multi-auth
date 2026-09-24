import { getCodexTuiMaskEmail, getCodexTuiMaskEmailInQuotaDetails, getQuotaDisplay, getQuotaStatus, loadPluginConfig } from "./config.js";
import { fetchTuiQuotaOverview, toQuotaOverviewAccounts } from "./tui-quota-overview.js";
import { readTuiQuotaSnapshot, isFreshTuiQuotaSnapshot, TUI_QUOTA_OVERVIEW_CACHE_FILE } from "./tui-quota-cache.js";
import { formatPromptStatusText, formatQuotaDetailsText, formatQuotaOverviewStatusLines, formatQuotaResetsStatusLines, type CompactQuotaStatus } from "./tui-status.js";
import { dirname, join } from "node:path";
import { getStoragePath, loadAccounts } from "./storage.js";
import { createUsageAccountFingerprint } from "./codex-usage.js";
import { resolveDisplayEmail } from "./account-display.js";

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
	const screen = status.screens[Math.floor(Date.now() / status.rotateMs) % status.screens.length];
	const overview = pool?.accounts.length && (screen !== "active" || quota.type !== "ready" || quota.stale)
		? await fetchTuiQuotaOverview({ cachePath: join(dirname(getStoragePath()), TUI_QUOTA_OVERVIEW_CACHE_FILE) })
		: null;
	const active = pool?.accounts[pool.activeIndex];
	const usage = active && overview?.accounts.find((account) => account.fingerprint === createUsageAccountFingerprint(active));
	if (usage && overview) {
		quota = { type: "ready", limits: usage.limits, stale: !isFreshTuiQuotaSnapshot(overview),
			source: "usage", fetchedAt: overview.fetchedAt, accountIndex: pool?.activeIndex,
			accountCount: pool?.accounts.length, accountEmail: active.email, accountLabel: active.accountLabel,
			planType: usage.planType };
	}
	let text = formatPromptStatusText({ quota, width, quotaDisplay, maskEmail });
	if (screen === "overview" || screen === "resets") {
		if (overview) {
			const format = screen === "resets" ? formatQuotaResetsStatusLines : formatQuotaOverviewStatusLines;
			text = format({
				accounts: toQuotaOverviewAccounts(overview), width, availableChars: width, maxRows: status.rows,
				options: { ...status, names: status.accountNames, mode: quotaDisplay, maskEmail },
			}).join("\n");
		}
	}
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
