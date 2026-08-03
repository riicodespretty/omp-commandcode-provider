import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "commandcode";
export const API_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const MODELS_URL = `${API_BASE_URL}/models`;
export const STUDIO_URL = "https://commandcode.ai/studio/";

const MODEL_FETCH_TIMEOUT_MS = 10_000;
const API_KEY_ENV_NAMES = [
	"COMMAND_CODE_API_KEY",
	"COMMANDCODE_API_KEY",
	"CMD_API_KEY",
] as const;

type CatalogModel = {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
};

type CatalogResponse = {
	data?: unknown;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;


export function configuredApiKeyEnvName(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	return API_KEY_ENV_NAMES.find((name) => Boolean(env[name]?.trim()));
}

export function commandCodeModelsFromCatalog(payload: unknown): ProviderModelConfig[] {
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("data" in payload) ||
		!Array.isArray(payload.data)
	) {
		throw new Error("Command Code model catalog did not contain a data array");
	}

	const models: ProviderModelConfig[] = [];
	const seenIds = new Set<string>();

	for (const item of (payload as CatalogResponse).data as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const { id: rawId, name: rawName, context_length: rawContextWindow } = item as CatalogModel;
		const id = typeof rawId === "string" ? rawId.trim() : "";
		if (!id || seenIds.has(id)) continue;
		seenIds.add(id);

		const api = /^claude(?:[-_.]|$)/i.test(id.split("/").at(-1) ?? id)
			? "anthropic-messages"
			: "openai-completions";
		const contextWindow =
			typeof rawContextWindow === "number" &&
			Number.isSafeInteger(rawContextWindow) &&
			rawContextWindow > 0
				? rawContextWindow
				: undefined;
		const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : id;
		const model = {
			id,
			name,
			api,
			...(contextWindow ? { contextWindow } : {}),
			...(api === "openai-completions"
				? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					}
				: {}),
		};

		// OMP enriches omitted capability fields from its bundled model catalog,
		// then applies conservative defaults for models it does not know yet.
		models.push(model as ProviderModelConfig);
	}

	if (models.length === 0) {
		throw new Error("Command Code model catalog contained no usable models");
	}
	return models;
}

export async function fetchCommandCodeModels(
	apiKey: string | undefined,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<ProviderModelConfig[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

	const response = await fetchImpl(MODELS_URL, {
		headers,
		signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`Command Code model discovery failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error("Command Code model discovery returned invalid JSON", { cause: error });
	}
	return commandCodeModelsFromCatalog(payload);
}

export async function loginWithCommandCode(callbacks: {
	onAuth(info: { url: string; instructions?: string }): void;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	signal?: AbortSignal;
}): Promise<string> {
	callbacks.onAuth({
		url: STUDIO_URL,
		instructions: "Create or copy a Provider API key in Command Code Studio, then paste it here.",
	});
	const apiKey = (
		await callbacks.onPrompt({
			message: "Paste your Command Code Provider API key:",
			placeholder: "user_...",
			allowEmpty: false,
		})
	).trim();
	if (callbacks.signal?.aborted) throw new Error("Command Code login cancelled");
	if (!apiKey) throw new Error("A Command Code Provider API key is required");
	return apiKey;
}

export default function commandCodeProvider(pi: ExtensionAPI): void {
	const apiKeyEnvName = configuredApiKeyEnvName();
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: API_BASE_URL,
		api: "openai-completions",
		...(apiKeyEnvName ? { apiKey: apiKeyEnvName } : {}),
		authHeader: true,
		oauth: {
			name: "Command Code",
			login: loginWithCommandCode,
		},
		fetchDynamicModels: fetchCommandCodeModels,
	});
}
