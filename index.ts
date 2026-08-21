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

export default function commandCodeProvider(pi: ExtensionAPI): void {
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
