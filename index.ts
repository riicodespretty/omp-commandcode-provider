import { createHash, randomUUID } from "node:crypto";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { API_ID, PROVIDER_ID, resolveBaseUrl, sanitizeApiKey } from "./src/api";
import { appendKey, readPool, removeKeyAt } from "./src/keys";
import { loginWithCommandCode, validateApiKey } from "./src/login";
import { COMMAND_CODE_MODELS } from "./src/models";
import { createCommandCodeStream } from "./src/stream";

// Captured on session_start; read by the stream and the /cc-keys command.
let authStorage: AuthStorage | undefined;
let sessionId: string | undefined;
let projectSlug = "0000000000";

const CC_KEYS_USAGE = "Usage: /cc-keys list | add <user_…> | remove <n>";

export default function commandCodeProvider(pi: ExtensionAPI): void {
	pi.on("session_start", (_e, ctx) => {
		authStorage = ctx.modelRegistry.authStorage;
		sessionId ??= randomUUID();
		projectSlug = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 10);
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: resolveBaseUrl(),
		api: API_ID,
		models: COMMAND_CODE_MODELS,
		streamSimple: createCommandCodeStream({
			getAuthStorage: () => authStorage,
			getSessionId: () => sessionId,
			getProjectSlug: () => projectSlug,
		}),
		// streamSimple owns the Authorization header, so no authHeader/apiKey.
		// /login establishes the first key; /cc-keys add is the only pool-growth path.
		oauth: { name: "Command Code", login: loginWithCommandCode },
	});

	pi.registerCommand("cc-keys", {
		description: "Manage Command Code API keys (list | add <key> | remove <n>)",
		handler: async (args, ctx) => {
			const ui = ctx.ui;
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] ?? "";

			if (!authStorage) {
				ui.notify("Command Code: no active session yet", "error");
				return;
			}

			if (sub === "list") {
				const pool = readPool(authStorage);
				if (pool.length === 0) {
					ui.notify("No Command Code API keys stored. Use /cc-keys add <user_…>.", "info");
					return;
				}
				// Position + last 4 chars only. The blocked column is omitted:
				// getModelUsageHealth requires a reserveFraction we cannot justify,
				// and static api_key credentials report "unknown" state (they bypass
				// the managed account pool), so a blocked column would mislead.
				const lines = pool.map((e, i) => `${i + 1}. …${e.key.slice(-4)}`);
				ui.notify(`Command Code keys:\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "add") {
				const raw = parts.slice(1).join(" ").trim();
				if (!raw) {
					ui.notify(CC_KEYS_USAGE, "error");
					return;
				}
				const key = sanitizeApiKey(raw);
				if (!key) {
					ui.notify("Command Code: empty API key after sanitizing.", "error");
					return;
				}
				try {
					await validateApiKey(key);
					const count = await appendKey(authStorage, key);
					ui.notify(`Command Code key stored (${count} key(s) total).`, "info");
				} catch (err) {
					ui.notify(`Command Code: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (sub === "remove") {
				const n = Number(parts[1] ?? "");
				if (!Number.isInteger(n) || n < 1) {
					ui.notify(CC_KEYS_USAGE, "error");
					return;
				}
				const removed = await removeKeyAt(authStorage, n);
				ui.notify(
					removed ? `Command Code key ${n} removed.` : `Command Code: no key at position ${n}.`,
					removed ? "info" : "error",
				);
				return;
			}

			ui.notify(CC_KEYS_USAGE, "error");
		},
	});
}
