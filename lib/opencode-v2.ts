import { createOpenAI } from "@ai-sdk/openai";
import { existsSync } from "node:fs";
import { Integration, type Credential, type Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createPluginRuntime } from "../index.js";
import { loadAccounts } from "./storage.js";
import { coordinatePersistedRefresh } from "./storage/coordinated-refresh.js";
import { logInfo, logWarn } from "./logger.js";
import type { Auth } from "@opencode-ai/sdk";
import { readV2Status } from "./opencode-v2-status.js";
import { CodexStatusRpc } from "./opencode-v2-rpc.js";
import { createStorageScope } from "./storage/state.js";
import { AUTH_LABELS } from "./constants.js";
import { openBrowserUrl } from "./auth/browser.js";

const providerModule = new URL("./opencode-v2-provider.js", import.meta.url);
// Local checkouts are loaded from TypeScript; published packages contain JS.
if (!existsSync(providerModule)) providerModule.pathname = providerModule.pathname.replace(/\.js$/, ".ts");
const providerPackage = `aisdk:${providerModule.href}`;

/** Set stateless options before the SDK lowers history into server-side references. */
function createV2Language(model: ReturnType<ReturnType<typeof createOpenAI>["responses"]>) {
	type Options = Parameters<typeof model.doGenerate>[0];
	const stateless = (options: Options): Options => {
		const openai: NonNullable<Options["providerOptions"]>[string] = { ...options.providerOptions?.openai, store: false };
		delete openai.previousResponseId;
		delete openai.conversation;
		return { ...options, providerOptions: { ...options.providerOptions, openai } };
	};
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property === "doGenerate") return (options: Options) => target.doGenerate(stateless(options));
			if (property === "doStream") return (options: Options) => target.doStream(stateless(options));
			return Reflect.get(target, property, receiver);
		},
	});
}

/** V1 supplied these defaults through provider options; V2's bridge needs them on the wire. */
export function createV2Fetch(fetcher: (input: Request | string | URL, init?: RequestInit) => Promise<Response>, version: string) {
	return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set("user-agent", `opencode/${version}`);
		if (request.method !== "POST" || !request.body) return fetcher(request);
		const body = await request.json() as Record<string, unknown>;
		body.store = false;
		body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
		return fetcher(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
	};
}

/** Keep account rotation and wire transforms in the shared runtime. */
export function setupV2(context: Plugin.Context) {
	const run = createStorageScope();
	return run(() => setupScopedV2(context, run));
}

async function setupScopedV2(context: Plugin.Context, run: ReturnType<typeof createStorageScope>) {
	const runtime = await createPluginRuntime({ directory: context.location.directory });
	const auth = runtime.auth;
	if (!auth?.loader) throw new Error("Codex authentication runtime is unavailable");
	const loader = auth.loader;
	const hasOAuth = async () => {
		if ((await loadAccounts())?.accounts.some((account) => account.enabled !== false && account.refreshToken)) return true;
		const connection = await context.integration.connection.active("openai");
		return connection ? (await context.integration.connection.resolve(connection))?.type === "oauth" : false;
	};
	let enabled = false;
	const reload = async () => { enabled = await hasOAuth(); await context.provider.reload(); };
	const controller = new AbortController();
	const cleanup = () => run(async () => {
		controller.abort();
		await runtime.event?.({ event: { type: "server.instance.disposed", properties: { directory: context.location.directory } } });
	});
	try {
		enabled = await hasOAuth();
		logInfo("V2 Codex adapter initialized", { enabled, directory: context.location.directory });
		await context.rpc.register(CodexStatusRpc, { status: (input) => run(() => readV2Status(input)) });
		// V2 runs authorization in the service, where the V1 readline menu cannot run.
		// Reuse the append-only loopback flow for the primary add-account method.
		await context.integration.transform((editor) => {
			for (const [index, method] of auth.methods.entries()) {
				if (method.type !== "oauth") continue;
				const primary = index === 0;
				const flowMethod = primary
					? auth.methods.find((candidate) => candidate.label === AUTH_LABELS.OAUTH_MANUAL_BROWSER)
					: method;
				if (flowMethod?.type !== "oauth") continue;
				const methodID = Integration.MethodID.make(`codex-multi-${index}`);
				editor.method.update({
					integrationID: "openai",
					method: { id: methodID, type: "oauth", label: primary ? "Codex OAuth (Add account — ChatGPT Plus/Pro)" : method.label },
					authorize: () => run(async () => {
						const flow = await flowMethod.authorize();
						if (primary && flow.url) openBrowserUrl(flow.url);
						const instructions = flow.url
							? `${flow.instructions}\nAdds to this project's Codex account pool. Use a private browser window or switch accounts to add a different login. Repeat opencode auth login for another account; view the pool with /codex-accounts.`
							: flow.instructions;
						const credential = (code?: string): Promise<Credential.OAuth> => run(async () => {
							const result = flow.method === "code" ? await flow.callback(code ?? "") : await flow.callback();
							if (result.type !== "success" || !("access" in result)) throw new Error("Codex sign-in failed; retry authentication");
							await reload();
							return { type: "oauth" as const, methodID, access: result.access, refresh: result.refresh, expires: result.expires };
						});
						return flow.method === "code"
							? { url: flow.url, instructions, mode: "code" as const, callback: credential }
							: { url: flow.url, instructions, mode: "auto" as const, callback: credential() };
					}),
					refresh: (credential) => run(async () => {
						const result = await coordinatePersistedRefresh({ refreshToken: credential.refresh });
						if (result.type !== "success") throw new Error("Codex token refresh failed");
						return { ...credential, access: result.access, refresh: result.refresh, expires: result.expires };
					}),
				});
			}
		});

		const resolveAuth = async (): Promise<Auth> => {
			const pool = await loadAccounts();
			const account = pool?.accounts[pool.activeIndex] ?? pool?.accounts[0];
			if (account?.refreshToken) {
				return { type: "oauth", access: account.accessToken ?? "", refresh: account.refreshToken, expires: account.expiresAt ?? 0 };
			}
			const connection = await context.integration.connection.active("openai");
			const credential = connection ? await context.integration.connection.resolve(connection) : undefined;
			if (credential?.type === "oauth") return credential;
			throw new Error("Connect a Codex multi-account OAuth method with /connect first");
		};

		await context.provider.transform((editor) => {
			if (!enabled) return;
			editor.update("openai", (provider) => {
				provider.package = providerPackage;
				provider.activation = "enabled";
				provider.settings = { ...provider.settings, transport: "http" };
			});
			for (const model of editor.get("openai")?.models.values() ?? []) {
				editor.models.update("openai", model.id, (draft) => { draft.package = providerPackage; });
			}
		});
		await context.aisdk.hook("sdk", (event) => run(async () => {
			if (!enabled) return;
			const options = await loader(resolveAuth, {
				id: "openai", name: "OpenAI", source: "custom", env: [], models: {},
				options: event.model.settings ?? {},
			});
			const fetcher = options.fetch;
			if (typeof fetcher !== "function") throw new Error("Codex request transport could not be initialized");
			event.sdk = createOpenAI({
				apiKey: typeof options.apiKey === "string" ? options.apiKey : "codex-oauth",
				baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
				fetch: createV2Fetch((input, init) => run(() => fetcher(input, init)), context.app.version),
			});
		}), { providerID: "openai" });
		await context.model.transform((editor) => {
			if (!enabled) return;
			for (const model of editor.list("openai")) {
				editor.update("openai", String(model.id), (draft) => {
					draft.package = providerPackage;
					draft.settings = { ...draft.settings, transport: "http" };
				});
			}
		});
		await context.aisdk.hook("language", (event) => {
			if (!enabled) return;
			const sdk = event.sdk as ReturnType<typeof createOpenAI>;
			event.language = createV2Language(sdk.responses(event.model.modelID));
		}, { providerID: "openai" });

		await context.tool.transform((editor) => {
			for (const [name, definition] of Object.entries(runtime.tool ?? {})) {
				const schema = z.object(definition.args);
				editor.add({
					name,
					description: definition.description,
					input: z.toJSONSchema(schema),
					execute: (input, call) => run(async () => {
						const result = await definition.execute(schema.parse(input), {
							sessionID: call.sessionID, messageID: call.messageID, agent: call.agent,
							directory: context.location.directory, worktree: context.location.project.directory,
							abort: call.signal,
					metadata: (update) => { void call.progress(update).catch(() => {}); },
							ask: () => { throw new Error("Legacy tool permission requests are not supported by the V2 adapter"); },
						});
						return { content: typeof result === "string" ? result : result.output };
					}),
				});
			}
		});
		void (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: controller.signal })) {
					if (event.location && event.location.directory !== context.location.directory) continue;
					if (event.type === "credential.updated" || event.type === "credential.switched") await reload();
				}
			} catch (error) {
				if (!controller.signal.aborted) logWarn("V2 event subscription ended", { error: String(error) });
			}
		})();
		return cleanup;
	} catch (error) {
		await cleanup();
		throw error;
	}
}
