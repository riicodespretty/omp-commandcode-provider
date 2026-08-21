import { createHash } from "node:crypto";
import type { AuthStorage, StoredAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { API_ID, PROVIDER_ID, resolveBaseUrl } from "./src/api";
import { fetchCommandCodeModels, resolveModelsTimeoutMs, resolveModelsUrl } from "./src/catalog";
import { fetchCommandCodeUsageForKeys } from "./src/commandcode-usage";
import { isCallable, isJsonString } from "./src/guards";
import { loginWithCommandCode } from "./src/login";
import { createCommandCodeStream } from "./src/stream";

let authStorage: AuthStorage | undefined;
let getSessionId: () => string | undefined = () => undefined;
let projectSlug = "0000000000";
const wrappedStorages = new WeakSet<object>();

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const remainderSeconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${remainderSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainderMinutes = minutes % 60;
	if (hours < 24) return `${hours}h${remainderMinutes}m`;
	const days = Math.floor(hours / 24);
	const remainderHours = hours % 24;
	return `${days}d${remainderHours}h`;
}

function asciiBar(fraction: number | undefined, width = 24): string {
	if (fraction === undefined) return `[${"·".repeat(width)}]`;
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * width);
	return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

const WINDOW_LABELS: ReadonlyArray<{ id: string; title: string }> = [
	{ id: "5h", title: "5 Hour limit" },
	{ id: "7d", title: "Weekly limit" },
	{ id: "monthly", title: "Monthly limit" },
];

function formatUsageForNotify(reports: UsageReport[] | null, now = Date.now()): string {
	if (!reports || reports.length === 0) return "No Command Code usage data available.";
	const lines: string[] = [];
	for (const window of WINDOW_LABELS) {
		const rows: string[] = [];
		for (const report of reports) {
			const limit = report.limits.find((l) => l.scope.windowId === window.id);
			if (!limit) continue;
			const rawAccount = report.metadata?.account;
			const account = isJsonString(rawAccount) ? rawAccount : "account";
			const reset =
				limit.window?.resetsAt && limit.window.resetsAt > now
					? ` (${formatDuration(limit.window.resetsAt - now)})`
					: "";
			const fraction = limit.amount.usedFraction;
			const reached = limit.notes?.includes("Limit reached");
			const suffix = reached
				? "  ⚠ Limit reached"
				: fraction === undefined
					? ""
					: ` ${Math.max(0, 100 - Math.round(fraction * 100)).toFixed(1)}% free`;
			rows.push(`${account}${reset}`);
			rows.push(`${asciiBar(fraction)}${suffix}`);
		}
		if (rows.length === 0) continue;
		lines.push(window.title);
		for (const row of rows) lines.push(`  ${row}`);
	}
	return lines.join("\n");
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
			const others =
				otherReports && otherReports.length > 0
					? otherReports.filter((entry) => entry.provider !== PROVIDER_ID)
					: [];
			return others.length > 0 || reports.length > 0 ? [...others, ...reports] : null;
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
