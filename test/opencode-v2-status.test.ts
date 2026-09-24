import { expect, it, vi } from "vitest";

vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({ codexTuiMaskEmail: true }),
	getCodexTuiMaskEmail: () => true,
}));
vi.mock("../lib/storage.js", () => ({
	getStoragePath: () => "/tmp/opencode/accounts.json",
	loadAccounts: async () => ({ activeIndex: 1, accounts: [
		{ email: "first@example.com", refreshToken: "private-refresh", accessToken: "private-access", enabled: false },
		{ accountLabel: "Work", email: "second@example.com", refreshToken: "another-refresh" },
	] }),
}));
vi.mock("../lib/tui-quota-cache.js", () => ({
	readTuiQuotaSnapshot: async () => null,
	isFreshTuiQuotaSnapshot: () => false,
	TUI_QUOTA_OVERVIEW_CACHE_FILE: "overview.json",
}));
vi.mock("../lib/tui-quota-overview.js", () => ({
	fetchTuiQuotaOverview: async () => null,
	toQuotaOverviewAccounts: () => [],
}));
import { readV2Status } from "../lib/opencode-v2-status.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

it("lists every account with masked identities even when quota is unavailable", async () => {
	const result = await readV2Status({ width: 80 });
	expect(result.accounts).toEqual([
		{ index: 1, label: resolveDisplayEmail("first@example.com", true), active: false, enabled: false },
		{ index: 2, label: "Work", active: true, enabled: true },
	]);
	expect(JSON.stringify(result)).not.toMatch(/private-refresh|private-access|another-refresh|first@example.com|second@example.com/);
});
