import { createHash } from "node:crypto";
import type { AuthStorage, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { API_ID, PROVIDER_ID, resolveBaseUrl } from "./src/api";
import { fetchCommandCodeModels, resolveModelsTimeoutMs, resolveModelsUrl } from "./src/catalog";
import { fetchCommandCodeUsage, mergeCommandCodeReport } from "./src/commandcode-usage";
import { isCallable } from "./src/guards";
import { loginWithCommandCode } from "./src/login";
import { createCommandCodeStream } from "./src/stream";

let authStorage: AuthStorage | undefined;
let getSessionId: () => string | undefined = () => undefined;
let projectSlug = "0000000000";
const wrappedStorages = new WeakSet<object>();

function formatUsageForNotify(report: UsageReport | null): string {
	if (!report) return "No Command Code usage data available.";
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
		return `- ${limit.label}: ${usedText}${reset}`;
	});
	return ["Command Code usage", ...lines].join("\n");
}

export default function commandCodeProvider(pi: ExtensionAPI): void {
	pi.registerCommand("usage-commandcode", {
		description: "Show Command Code account usage (credits, plan, billing period).",
		async handler(_args, ctx) {
			const storage = ctx.modelRegistry.authStorage;
			let apiKey: string | undefined;
			try {
				apiKey = await storage.getApiKey(PROVIDER_ID, ctx.sessionManager.getSessionId());
			} catch {
				ctx.ui.notify("Command Code is not logged in. Run /login and pick Command Code.", "error");
				return;
			}
			if (!apiKey) {
				ctx.ui.notify("Command Code is not logged in. Run /login and pick Command Code.", "error");
				return;
			}
			let report: UsageReport | null = null;
			try {
				report = await fetchCommandCodeUsage({
					apiKey,
					baseUrl: resolveBaseUrl(),
					sessionId: ctx.sessionManager.getSessionId(),
					projectSlug: createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 10),
				});
			} catch {
				ctx.ui.notify("Could not fetch Command Code usage.", "error");
				return;
			}
			ctx.ui.notify(formatUsageForNotify(report), "info");
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
			let apiKey: string | undefined;
			try {
				apiKey = await raw.getApiKey(PROVIDER_ID, getSessionId());
			} catch {
				return otherReports;
			}
			if (!apiKey) return otherReports;
			const baseUrl = options?.baseUrlResolver?.(PROVIDER_ID) ?? resolveBaseUrl();
			let report: UsageReport | null = null;
			try {
				report = await fetchCommandCodeUsage({
					apiKey,
					baseUrl,
					sessionId: getSessionId(),
					projectSlug,
					signal: options?.signal,
				});
			} catch {
				return otherReports;
			}
			return mergeCommandCodeReport(otherReports, report);
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
