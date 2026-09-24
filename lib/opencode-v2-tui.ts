import type { Plugin } from "@opencode/plugin/tui";
import { createElement, spread } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { CodexStatusRpc } from "./opencode-v2-rpc.js";

export function setupV2Tui(context: Plugin.Context) {
	const [text, setText] = createSignal("");
	const [accounts, setAccounts] = createSignal("Loading accounts…");
	const [showFor, setShowFor] = createSignal("always");
	const disposers = [context.ui.slot({
		append: "app",
		render: () => {
			let details = "Quota is loading.";
			let disposed = false;
			let pending = false;
			const controller = new AbortController();
			const rpc = context.client.rpc(CodexStatusRpc);
			const refresh = async () => {
				if (pending || disposed) return;
				pending = true;
				try {
					const result = await rpc.status({ width: Math.max(1, Math.min(1000, context.renderer.width - 40)) }, {
						location: context.location ?? context.data.location.default(), signal: controller.signal,
					});
					if (disposed) return;
					setText(result.text);
					setShowFor(result.showFor);
					setAccounts(result.accounts.length ? result.accounts.map((account) =>
						`${account.active ? "●" : "○"} ${account.index}. ${account.label}${account.enabled ? "" : " (disabled)"}`,
					).join("\n") : "No Codex accounts in this pool.");
					details = result.details;
				} catch {
					if (!disposed) {
						setText("limits ?");
						setAccounts("Accounts unavailable — retry shortly.");
						details = "Quota unavailable — retry shortly.";
					}
				} finally {
					pending = false;
				}
			};
			void refresh();
			const timer = setInterval(() => { void refresh(); }, 2_000);
			context.keymap.layer(() => ({
				mode: "global",
				commands: [{
					id: "codex.quota.details", title: "Codex quota details", group: "Codex", palette: true,
					async run() {
						await refresh();
						await context.ui.dialog.alert({ title: "Codex quota", message: details });
					},
				}, {
					id: "codex.accounts", title: "Codex accounts", group: "Codex", palette: true,
					slash: { name: "codex-accounts" },
					async run() {
						await refresh();
						await context.ui.dialog.alert({
							title: "Codex accounts",
							message: `${accounts()}\n\nAdd an account: run opencode auth login from this project directory, then select OpenAI → Codex OAuth (Add account — ChatGPT Plus/Pro). Repeat for each account, using a private browser window to choose a different login.`,
						});
					},
				}],
			}));
			onCleanup(() => { disposed = true; controller.abort(); clearInterval(timer); });
			return null;
		},
	}), context.ui.slot({
		append: "prompt.footer.status",
		render: (props) => {
			const element = createElement("text");
			spread(element, {
				get children() {
					const providerID = props.sessionID ? context.data.session.get(props.sessionID)?.model?.providerID : undefined;
					return showFor() === "codex-models" && providerID && providerID !== "openai" ? "" : text();
				},
				get fg() { return context.theme.text.base; },
			});
			return element;
		},
	}), context.ui.slot({
		append: "sidebar.content",
		render: () => {
			const element = createElement("text");
			spread(element, {
				get children() { return `\nCodex accounts\n${accounts()}\n/codex-accounts`; },
				get fg() { return context.theme.text.base; },
			});
			return element;
		},
	})];
	return () => { for (const dispose of disposers) dispose(); };
}
