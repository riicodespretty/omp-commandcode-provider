import { createHash } from "node:crypto";
import type { AuthStorage, StoredAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { API_ID, PROVIDER_ID, resolveBaseUrl } from "./src/api";
import { fetchCommandCodeModels, resolveModelsTimeoutMs, resolveModelsUrl } from "./src/catalog";
import { fetchCommandCodeUsageForKeys, mergeCommandCodeReport } from "./src/commandcode-usage";
import { isCallable, isJsonString } from "./src/guards";
import { loginWithCommandCode } from "./src/login";
import { createCommandCodeStream } from "./src/stream";

let authStorage: AuthStorage | undefined;
let getSessionId: () => string | undefined = () => undefined;
let projectSlug = "0000000000";
const wrappedStorages = new WeakSet<object>();

function formatUsageForNotify(reports: UsageReport[] | null): string {
	if (!reports || reports.length === 0) return "No Command Code usage data available.";
	const sections = reports.map((report) => {
		const rawAccount = report.metadata?.account;
		const account = isJsonString(rawAccount) ? rawAccount : "account";
		const lines = report.limits.map((limit) => {
			const used = limit.amount.used ?? limit.amount.usedFraction;
			const suffix =
				limit.amount.unit === "percent"
					? "%"
					: limit.amount.unit === "usd"
						? " USD"
						: ` ${limit.amount.unit}`;
			const usedText =
				used === undefined
					? "unknown"
					: Number.isFinite(used)
						? `${used.toFixed(2)}${suffix}`
						: String(used);
			const reset = limit.window?.resetsAt
				? ` (resets ${new Date(limit.window.resetsAt).toISOString().slice(0, 10)})`
				: "";
			const pct =
				limit.amount.usedFraction !== undefined
					? ` (${(limit.amount.usedFraction * 100).toFixed(0)}%)`
					: "";
			return `- ${limit.label}: ${usedText}${pct}${reset}`;
		});
		return [`Command Code — ${account}`, ...lines].join("\n");
	});
	return sections.join("\n\n");
}

function storedApiKeys(rows: StoredAuthCredential[]): string[] {
	const keys: string[] = [];
	for (const row of rows) {
		const credential = row.credential;
		if (credential.type === "api_key" && credential.key) keys.push(credential.key);
	}
	return keys;
}

export default function commandCodeProvider(pi: ExtensionAPI): void {
	pi.registerCommand("usage-commandcode", {
		description: "Show Command Code usage for every logged-in account.",
		async handler(_args, ctx) {
			const storage = ctx.modelRegistry.authStorage;
			let rows: StoredAuthCredential[];
			try {
				rows = storage.listStoredCredentials(PROVIDER_ID);
			} catch {
				ctx.ui.notify("Command Code is not logged in. Run /login and pick Command Code.", "error");
				return;
			}
			const apiKeys = storedApiKeys(rows);
			if (apiKeys.length === 0) {
				ctx.ui.notify("Command Code is not logged in. Run /login and pick Command Code.", "error");
				return;
			}
			let reports: UsageReport[] | null = null;
			try {
				reports = await fetchCommandCodeUsageForKeys(apiKeys, {
					baseUrl: resolveBaseUrl(),
					sessionId: ctx.sessionManager.getSessionId(),
					projectSlug: createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 10),
				});
			} catch {
				ctx.ui.notify("Could not fetch Command Code usage.", "error");
				return;
			}
			ctx.ui.notify(formatUsageForNotify(reports), "info");
		},
	});

	pi.on("session_start", (_e, ctx) => {
		authStorage = ctx.modelRegistry.authStorage;
		getSessionId = () => ctx.sessionManager.getSessionId() || undefined;
		projectSlug = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 10);

		if (authStorage === undefined) return;
		// SAFETY: real AuthStorage instances expose getApiKey and an optional
		// fetchUsageReports hook; both are probed (isCallable) before use, so
		// absent hooks degrade to the unwrapped storage path.
		const raw = authStorage as AuthStorage & {
			fetchUsageReports?: (o?: {
				baseUrlResolver?: (p: string) => string | undefined;
				signal?: AbortSignal;
			}) => Promise<UsageReport[] | null>;
		};
		if (!isCallable(raw.fetchUsageReports)) return;
		if (wrappedStorages.has(raw)) return;
		const orig = raw.fetchUsageReports.bind(raw);
		raw.fetchUsageReports = async (options?: {
			baseUrlResolver?: (provider: string) => string | undefined;
			signal?: AbortSignal;
		}): Promise<UsageReport[] | null> => {
			const otherReports = await orig(options);
			let apiKeys: string[] = [];
			try {
				apiKeys = storedApiKeys(raw.listStoredCredentials(PROVIDER_ID));
			} catch {
				return otherReports;
			}
			if (apiKeys.length === 0) return otherReports;
			const baseUrl = options?.baseUrlResolver?.(PROVIDER_ID) ?? resolveBaseUrl();
			let reports: UsageReport[] = [];
			try {
				reports = await fetchCommandCodeUsageForKeys(apiKeys, {
					baseUrl,
					sessionId: getSessionId(),
					projectSlug,
					signal: options?.signal,
				});
			} catch {
				return otherReports;
			}
			let merged = otherReports;
			for (const report of reports) merged = mergeCommandCodeReport(merged, report);
			return merged;
		};
		wrappedStorages.add(raw);
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: resolveBaseUrl(),
		api: API_ID,
		fetchDynamicModels: (apiKey) =>
			fetchCommandCodeModels({
				url: resolveModelsUrl(),
				timeoutMs: resolveModelsTimeoutMs(),
				apiKey,
			}),
		streamSimple: createCommandCodeStream({
			getAuthStorage: () => authStorage,
			getSessionId: () => getSessionId(),
			getProjectSlug: () => projectSlug,
		}),
		oauth: { name: "Command Code", login: loginWithCommandCode },
	});
}
