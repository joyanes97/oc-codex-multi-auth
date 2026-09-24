import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, Provider, type Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

const mocks = vi.hoisted(() => ({
	runtime: vi.fn(), loadAccounts: vi.fn(), refresh: vi.fn(), openBrowser: vi.fn(), interactive: vi.fn(),
}));
vi.mock("../lib/auth/browser.js", () => ({ openBrowserUrl: mocks.openBrowser }));
vi.mock("../index.js", () => ({ createPluginRuntime: mocks.runtime }));
vi.mock("../lib/storage.js", () => ({ loadAccounts: mocks.loadAccounts }));
vi.mock("../lib/storage/coordinated-refresh.js", () => ({ coordinatePersistedRefresh: mocks.refresh }));
vi.mock("../lib/opencode-v2-status.js", () => ({ readV2Status: vi.fn() }));
import { createV2Fetch, setupV2 } from "../lib/opencode-v2.js";
import { createStorageScope, getStoragePath, setStoragePathDirect, subscribeToStoragePathChanges } from "../lib/storage/state.js";

function host() {
	const methods: IntegrationOAuthMethodRegistration[] = [];
	const tools: ToolInfo[] = [];
	const hooks = new Map<string, (event: AISDKHooks["sdk"] | AISDKHooks["language"]) => Promise<void>>();
	const model = Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-5.5"));
	const provider = Provider.Info.empty(Provider.ID.make("openai"));
	const editor = {
		update: (_id: string, update: (value: typeof provider) => void) => update(provider),
		get: () => ({ provider, models: new Map([[model.id, model]]) }),
		models: { update: (_provider: string, _id: string, update: (value: typeof model) => void) => update(model) },
	};
	const context = {
		app: { version: "2.0.16" },
		location: { directory: "/tmp/opencode/v2-test", project: { directory: "/tmp/opencode/v2-test" } },
		rpc: { register: vi.fn() },
		integration: {
			connection: { active: vi.fn(), resolve: vi.fn() },
			transform: async (callback: (input: unknown) => void) => callback({ method: { update: (value: IntegrationOAuthMethodRegistration) => methods.push(value) } }),
		},
		provider: { reload: vi.fn(), transform: async (callback: (input: unknown) => void) => callback(editor) },
		model: { transform: async (callback: (input: unknown) => void) => callback({
			list: () => [model], update: (_provider: string, _id: string, update: (value: typeof model) => void) => update(model),
		}) },
		aisdk: { hook: vi.fn(async (name, callback) => { hooks.set(name, callback); }) },
		tool: { transform: async (callback: (input: unknown) => void) => callback({ add: (value: ToolInfo) => tools.push(value) }) },
		event: { subscribe: vi.fn(async function* () { /* empty public event stream */ }) },
	};
	return { context: context as unknown as Plugin.Context, methods, tools, hooks, model, provider };
}

describe("V2 compatibility adapter", () => {
	const event = vi.fn();
	const callback = vi.fn();
	const transport = vi.fn(async () => new Response("ok"));
	const loader = vi.fn(async (getAuth: () => Promise<unknown>) => {
		await getAuth();
		return { apiKey: "placeholder", fetch: transport };
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ refreshToken: "test-refresh", accessToken: "test-access", expiresAt: 123 }] });
		callback.mockResolvedValue({ type: "success", access: "new-access", refresh: "new-refresh", expires: 456 });
		mocks.runtime.mockResolvedValue({ event, auth: { loader, methods: [
			{ type: "oauth", label: "Interactive setup", authorize: mocks.interactive },
			{ type: "oauth", label: "Codex OAuth (Open URL Manually)", authorize: async () => ({ url: "https://example.com", instructions: "Sign in", method: "auto", callback }) },
			{ type: "oauth", label: "Manual", authorize: async () => ({ url: "https://example.com", instructions: "Paste code", method: "code", callback }) },
		] }, tool: {
			"codex-test": { description: "Example", args: { value: z.number().default(2) }, execute: async (input: { value: number }) => String(input.value) },
		} });
	});
	afterEach(() => vi.restoreAllMocks());

	it("uses a distinct provider package so V2 cannot rewrite the transport to native OpenAI", async () => {
		const h = host();
		const cleanup = await setupV2(h.context);
		expect(h.provider.package).toMatch(/^aisdk:file:.*opencode-v2-provider\.(ts|js)$/);
		expect(h.model.package).toBe(h.provider.package);
		const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		await h.hooks.get("sdk")?.(sdkEvent);
		expect(sdkEvent.sdk).toBeDefined();
		expect(loader).toHaveBeenCalled();
		expect(h.context.aisdk.hook).toHaveBeenCalledWith("sdk", expect.any(Function), { providerID: "openai" });
		await cleanup();
		expect(event).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: "server.instance.disposed" }) }));
	});

	it("leaves API-key-only OpenAI routing alone", async () => {
		mocks.loadAccounts.mockResolvedValue(null);
		const h = host();
		const original = h.provider.package;
		const cleanup = await setupV2(h.context);
		expect(h.provider.package).toBe(original);
		await h.hooks.get("sdk")?.({ model: h.model, package: original, options: {} });
		expect(loader).not.toHaveBeenCalled();
		await cleanup();
	});

	it.each(["doGenerate", "doStream"] as const)("preserves multi-turn history before %s serialization", async (method) => {
		const h = host();
		const cleanup = await setupV2(h.context);
		const captured: Record<string, unknown>[] = [];
		const stop = new Error("captured request");
		const sdk = createOpenAI({
			apiKey: "test-key",
			fetch: async (_input, init) => {
				captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				throw stop;
			},
		});
		const languageEvent: AISDKHooks["language"] = { model: h.model, sdk };
		await h.hooks.get("language")?.(languageEvent);
		const options: Parameters<ReturnType<typeof sdk.responses>["doGenerate"]>[0] = {
			providerOptions: { openai: { store: true, previousResponseId: "resp_old", conversation: "conv_old", parallelToolCalls: false } },
			prompt: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [
					{ type: "text", text: "Hello!", providerOptions: { openai: { itemId: "msg_previous" } } },
					{ type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_previous", reasoningEncryptedContent: "encrypted-history" } } },
					{ type: "tool-call", toolCallId: "call_limits", toolName: "codex_limits", input: "{}" },
				] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_limits", toolName: "codex_limits", output: { type: "text", value: "Quota available" } }] },
				{ role: "user", content: [{ type: "text", text: "what are my limits?" }] },
			],
		};
		try {
			await expect(languageEvent.language![method](options)).rejects.toThrow("captured request");
			expect(captured).toHaveLength(1);
			const body = captured[0]!;
			expect(body).toMatchObject({ store: false, parallel_tool_calls: false });
			expect(body).not.toHaveProperty("previous_response_id");
			expect(body).not.toHaveProperty("conversation");
			expect(body.input).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "assistant", content: [{ type: "output_text", text: "Hello!" }] }),
				expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted-history" }),
				expect.objectContaining({ type: "function_call", call_id: "call_limits" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call_limits", output: "Quota available" }),
			]));
			expect(body.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "item_reference" })]));
			expect(options.providerOptions?.openai?.store).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("adapts automatic and pasted-code OAuth without invoking terminal-interactive setup", async () => {
		const h = host();
		const cleanup = await setupV2(h.context);
		expect(h.methods.map((method) => method.method.label)).toEqual([
			"Codex OAuth (Add account — ChatGPT Plus/Pro)", "Codex OAuth (Open URL Manually)", "Manual",
		]);
		const browser = await h.methods[0]!.authorize({});
		expect(browser.mode).toBe("auto");
		expect(await browser.callback).toMatchObject({ type: "oauth", methodID: "codex-multi-0", refresh: "new-refresh" });
		expect(browser.instructions).toContain("Repeat opencode auth login");
		expect(mocks.openBrowser).toHaveBeenCalledWith("https://example.com");
		expect(mocks.interactive).not.toHaveBeenCalled();
		mocks.openBrowser.mockClear();
		const link = await h.methods[1]!.authorize({});
		await link.callback;
		expect(mocks.openBrowser).not.toHaveBeenCalled();
		const manual = await h.methods[2]!.authorize({});
		if (manual.mode !== "code") throw new Error("Expected code mode");
		await manual.callback("callback-code");
		expect(callback).toHaveBeenCalledWith("callback-code");
		callback.mockResolvedValue({ type: "failed" });
		await expect(manual.callback("invalid")).rejects.toThrow("sign-in failed");
		await cleanup();
	});

	it("pins host refresh to the original seat after the pool rotates its token", async () => {
		const h = host();
		const cleanup = await setupV2(h.context);
		const access = `header.${Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_account_user_id: "member-b" },
		})).toString("base64url")}.signature`;
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-a", refreshToken: "rotated-a" },
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-b", refreshToken: "rotated-b" },
		] });
		mocks.refresh.mockResolvedValue({ type: "success", access: "updated", refresh: "rotated-b", expires: 456 });
		const refreshed = await h.methods[0]!.refresh({ type: "oauth", methodID: "codex-multi-0", access, refresh: "old-b", expires: 0 });
		expect(mocks.refresh).toHaveBeenCalledWith({
			refreshToken: "old-b", organizationId: "org", accountId: "workspace", accountUserId: "member-b",
		});
		expect(refreshed).toMatchObject({ access: "updated", refresh: "rotated-b" });
		await cleanup();
	});

	it("retains tool validation and defaults across JSON Schema registration", async () => {
		const h = host();
		const cleanup = await setupV2(h.context);
		const tool = h.tools[0]!;
		expect(tool.input).toMatchObject({ type: "object" });
		const call = { signal: new AbortController().signal, progress: vi.fn() } as unknown as Parameters<typeof tool.execute>[1];
		await expect(tool.execute({}, call)).resolves.toEqual({ content: "2" });
		await expect(tool.execute({ value: "wrong" }, call)).rejects.toThrow();
		await cleanup();
	});

	it("enforces stateless wire defaults and preserves headers and cancellation", async () => {
		const abort = new AbortController();
		const fetcher = vi.fn(async (_input: Request | string | URL, _init?: RequestInit) => new Response("ok"));
		await createV2Fetch(fetcher, "2.0.16")("https://example.com/responses", {
			method: "POST", headers: { "x-test": "preserved" }, signal: abort.signal,
			body: JSON.stringify({ model: "gpt-5.5", store: true, include: ["other"] }),
		});
		const init = fetcher.mock.calls[0]![1]!;
		expect(JSON.parse(String(init.body))).toMatchObject({ store: false, include: ["other", "reasoning.encrypted_content"] });
		expect(new Headers(init.headers).get("x-test")).toBe("preserved");
		expect(new Headers(init.headers).get("user-agent")).toBe("opencode/2.0.16");
		abort.abort();
		expect(init.signal?.aborted).toBe(true);
	});
});

it("isolates simultaneous V2 location storage and path listeners", async () => {
	const first = createStorageScope();
	const second = createStorageScope();
	const listener = vi.fn();
	const previous = getStoragePath();
	await Promise.all([
		first(async () => {
			setStoragePathDirect("/tmp/opencode/first.json");
			subscribeToStoragePathChanges(listener);
			await Promise.resolve();
			expect(getStoragePath()).toBe("/tmp/opencode/first.json");
		}),
		second(async () => {
			setStoragePathDirect("/tmp/opencode/second.json");
			await Promise.resolve();
			expect(getStoragePath()).toBe("/tmp/opencode/second.json");
		}),
	]);
	expect(listener).not.toHaveBeenCalled();
	expect(getStoragePath()).toBe(previous);
});
