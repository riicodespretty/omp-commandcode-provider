import { describe, expect, test } from "bun:test";

import commandCodeProvider, {
	API_BASE_URL,
	MODELS_URL,
	PROVIDER_ID,
	STUDIO_URL,
	commandCodeModelsFromCatalog,
	configuredApiKeyEnvName,
	fetchCommandCodeModels,
	loginWithCommandCode,
} from "./index.ts";

describe("Command Code catalog", () => {
	test("routes Claude through Messages and all other models through Chat Completions", () => {
		const models = commandCodeModelsFromCatalog({
			data: [
				{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
				{
					id: "deepseek/deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					context_length: 128_000,
				},
				{ id: "deepseek/deepseek-v4-flash", name: "duplicate" },
				{ id: "", name: "invalid" },
			],
		});

		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({
			id: "claude-sonnet-4-6",
			api: "anthropic-messages",
			contextWindow: 1_000_000,
		});
		expect(models[1]).toMatchObject({
			id: "deepseek/deepseek-v4-flash",
			api: "openai-completions",
			contextWindow: 128_000,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
		});
	});

	test("rejects malformed and empty catalogs", () => {
		expect(() => commandCodeModelsFromCatalog({})).toThrow("data array");
		expect(() => commandCodeModelsFromCatalog({ data: [{ name: "missing id" }] })).toThrow(
			"no usable models",
		);
	});

	test("fetches the live catalog with the resolved key", async () => {
		let requestUrl = "";
		let authorization: string | null = null;
		const models = await fetchCommandCodeModels("  user_test  ", async (input, init) => {
			requestUrl = String(input);
			authorization = new Headers(init?.headers).get("authorization");
			return Response.json({
				data: [{ id: "gpt-5.4", name: "GPT-5.4", context_length: 1_000_000 }],
			});
		});

		expect(requestUrl).toBe(MODELS_URL);
		expect(authorization).toBe("Bearer user_test");
		expect(models[0]?.id).toBe("gpt-5.4");
	});
});

describe("Command Code provider registration", () => {
	test("registers the dynamic provider on OMP's native API", () => {
		let registration:
			| { provider: string; config: Record<string, unknown> }
			| undefined;
		commandCodeProvider({
			registerProvider(provider: string, config: Record<string, unknown>) {
				registration = { provider, config };
			},
		} as never);

		expect(registration?.provider).toBe(PROVIDER_ID);
		expect(registration?.config).toMatchObject({
			baseUrl: API_BASE_URL,
			api: "openai-completions",
			authHeader: true,
		});
		expect(typeof registration?.config.fetchDynamicModels).toBe("function");
		expect(registration?.config.oauth).toMatchObject({ name: "Command Code" });
	});

	test("recognizes supported API key environment variables", () => {
		expect(configuredApiKeyEnvName({ COMMAND_CODE_API_KEY: "official" })).toBe(
			"COMMAND_CODE_API_KEY",
		);
		expect(configuredApiKeyEnvName({ COMMANDCODE_API_KEY: "legacy" })).toBe(
			"COMMANDCODE_API_KEY",
		);
		expect(configuredApiKeyEnvName({ CMD_API_KEY: "alternate" })).toBe("CMD_API_KEY");
		expect(configuredApiKeyEnvName({ COMMAND_CODE_API_KEY: "  " })).toBeUndefined();
	});

	test("opens Studio and stores the pasted key", async () => {
		let authUrl = "";
		const apiKey = await loginWithCommandCode({
			onAuth(info) {
				authUrl = info.url;
			},
			onPrompt: async () => "  user_test  ",
		});

		expect(authUrl).toBe(STUDIO_URL);
		expect(apiKey).toBe("user_test");
	});
});
