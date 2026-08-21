import { afterEach, describe, expect, test } from "vite-plus/test";
import type {
	Api,
	ApiKeyResolveContext,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AuthStorage,
	Context,
	Model,
	StoredAuthCredential,
	UsageLimitMarkResult,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";

import commandCodeProvider from "./index";
import {
	buildHeaders,
	classifyFailure,
	PROVIDER_ID,
	resetAtMs,
	resolveBaseUrl,
	sanitizeApiKey,
} from "./src/api";
import {
	DEFAULT_MODELS_TIMEOUT_MS,
	fetchCommandCodeModels,
	MODELS_PATH,
	modelsFromApiResponse,
	resolveModelsTimeoutMs,
	resolveModelsUrl,
} from "./src/catalog";
import { capabilitiesForModel, DEFAULT_MODEL_ID, MODEL_CAPABILITIES } from "./src/models";
import { costForModel, MODEL_COSTS, ZERO_COST } from "./src/pricing";
import { createCommandCodeStream } from "./src/stream";
import {
	PLAN_NAMES,
	buildUsageReport,
	fetchCommandCodeUsage,
	fetchCommandCodeUsageReports,
	mergeCommandCodeReport,
	parseCredits,
	parseSubscription,
	parseSummary,
	parseWhoami,
} from "./src/commandcode-usage";
import { loginWithCommandCode } from "./src/login";

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

/** Minimal `Model<Api>` the stream touches: id, maxTokens, reasoning. */
function makeModel(
	overrides: Partial<Pick<Model<Api>, "id" | "maxTokens" | "reasoning">> = {},
): Model<Api> {
	return {
		id: overrides.id ?? "deepseek/deepseek-v4-flash",
		name: "test model",
		api: "commandcode-generate",
		provider: "commandcode",
		baseUrl: "https://api.commandcode.ai",
		reasoning: overrides.reasoning ?? false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: overrides.maxTokens ?? 64_000,
		compat: undefined,
	};
}

/** A `Context` with one user text message and no tools. */
function makeContext(text = "Reply with the single word: ok"): Context {
	return {
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
	};
}

/** Build a `Response` whose body is a ReadableStream emitting the given chunks.
 *  `Response.ok` is auto-derived from `status` (200–299 → true). */
function makeResponse(chunks: Uint8Array[], status = 200): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Encode a string into a UTF-8 Uint8Array chunk. */
function enc(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** The valid ndjson body used across stream tests. */
const VALID_NDJSON =
	'{"type":"text-delta","text":"He"}\n' +
	'{"type":"text-delta","text":"llo"}\n' +
	'{"type":"finish","finishReason":"end_turn","totalUsage":{"inputTokens":5,"outputTokens":2}}\n';

/** Split VALID_NDJSON mid-line into two chunks (the break is inside `llo`). */
function splitMidLine(): [Uint8Array, Uint8Array] {
	const full = VALID_NDJSON;
	// Break inside the second text-delta line, after `"l` — mid-line.
	const cut = full.indexOf('"llo"') + 2;
	return [enc(full.slice(0, cut)), enc(full.slice(cut))];
}

/** Collect every event from an AssistantMessageEventStream into an array. */
async function collectEvents(stream: {
	[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
}): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

/** Extract the final AssistantMessage from a settled stream via result(). */
async function finalMessage(stream: {
	result(): Promise<AssistantMessage>;
}): Promise<AssistantMessage> {
	return stream.result();
}

/** True for a plain string request target. */
function isStringUrl(value: URL | RequestInfo): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

/** True when a fetch body is a plain string. */
function isBodyString(value: BodyInit | null | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

/** The URL string of a fetch input, without stringifying Request objects. */
function urlOf(input: URL | RequestInfo): string {
	if (input instanceof URL) return input.href;
	if (isStringUrl(input)) return input;
	return input.url;
}

/** A single-assertion typed factory for fetch-like fixtures. */
function asFetchImpl(
	fn: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	// SAFETY: the fixture is a faithful fetch substitute for the exercised
	// call sites; the cast bridges only the preconnect/static surface.
	return fn as typeof fetch;
}

/** A single-assertion typed factory for AuthStorage-shaped fixtures. */
function asAuthStorage<T extends object>(v: T): T & AuthStorage {
	// SAFETY: the fixture implements every AuthStorage member the exercised
	// path touches; the cast supplies the members the path never calls.
	return v as T & AuthStorage;
}

/** A single-assertion typed factory for ExtensionAPI-shaped fixtures. */
function asExtensionApi<T extends object>(v: T): T & ExtensionAPI {
	// SAFETY: the fixture implements every ExtensionAPI member the plugin
	// calls; the cast supplies the members the plugin never touches.
	return v as T & ExtensionAPI;
}

/** A recording fetch that routes by Authorization bearer. */
interface FetchRecorder {
	fetch: typeof fetch;
	calls: { auth: string; body: string }[];
}

function fetchByBearer(routes: Record<string, () => Response>): FetchRecorder {
	const calls: { auth: string; body: string }[] = [];
	const fn: typeof fetch = Object.assign(
		async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
			// SAFETY: fetch accepts plain objects for headers; the recorder
			// reads only the Authorization entry it wrote.
			const headers = init?.headers as Record<string, string> | undefined;
			const auth = headers?.Authorization ?? "";
			const rawBody = init?.body;
			const bodyText = isBodyString(rawBody) ? rawBody : "";
			calls.push({ auth, body: bodyText });
			const factory = routes[auth];
			if (!factory) throw new Error(`unexpected bearer ${auth} for ${urlOf(input)}`);
			return factory();
		},
		{ preconnect: () => undefined },
	);
	return { fetch: fn, calls };
}

/** Options the stream forwards to markUsageLimitReached. */
interface MarkUsageOptions {
	retryAfterMs?: number;
	baseUrl?: string;
	modelId?: string;
	apiKey?: string;
	credentialId?: number;
	signal?: AbortSignal;
}

/** Options the stream forwards to rotateSessionCredential. */
interface RotateOptions {
	error?: unknown;
	modelId?: string;
	apiKey?: string;
	credentialId?: number;
	signal?: AbortSignal;
}

/** Options the stream forwards to resolver(). */
interface ResolverOptions {
	sessionId?: string;
	baseUrl?: string;
	modelId?: string;
}

/** The subset of AuthStorage the stream exercises. Test double for a large
 *  third-party interface (~30 methods) — only these five are touched. */
interface StreamAuthStorage {
	getApiKey(provider: string, sessionId?: string): Promise<string | undefined>;
	markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageOptions,
	): Promise<UsageLimitMarkResult>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: RotateOptions,
	): Promise<boolean>;
	listStoredCredentials(provider?: string): StoredAuthCredential[];
	resolver(provider: string, options?: ResolverOptions): ApiKeyResolver;
}

/** A stub AuthStorage whose getApiKey yields keys in order, with live call counters. */
function stubAuthStorage(opts: {
	keys: string[];
	markResult?: UsageLimitMarkResult;
	rotateResult?: boolean;
}): AuthStorage & { markCalls: number; rotateCalls: number } {
	let idx = 0;
	const counts = { mark: 0, rotate: 0 };
	const base: StreamAuthStorage = {
		getApiKey: async () => {
			// Yield keys in order; once exhausted, repeat the last. This mirrors
			// the real resolver: after a non-rotating retry it returns the same key.
			const k = opts.keys[Math.min(idx, opts.keys.length - 1)];
			idx += 1;
			return k;
		},
		markUsageLimitReached: async () => {
			counts.mark += 1;
			return opts.markResult ?? { switched: false };
		},
		rotateSessionCredential: async () => {
			counts.rotate += 1;
			return opts.rotateResult ?? false;
		},
		listStoredCredentials: () => [],
		// Mirrors createApiKeyResolver: initial/refresh resolve reads the store,
		// lastChance rotates first. Ordered getApiKey supplies the sibling.
		resolver:
			(): ApiKeyResolver =>
			async ({ lastChance, error, previousKey, signal }: ApiKeyResolveContext) => {
				if (error !== undefined && lastChance) {
					await base.rotateSessionCredential(PROVIDER_ID, undefined, {
						error,
						apiKey: previousKey,
						signal,
					});
				}
				return base.getApiKey(PROVIDER_ID, undefined);
			},
	};
	// SAFETY: the stub implements every AuthStorage member the stream
	// touches; the cast supplies the unrelated members for the large interface.
	const stub = base as AuthStorage;
	Object.defineProperty(stub, "markCalls", { get: () => counts.mark });
	Object.defineProperty(stub, "rotateCalls", { get: () => counts.rotate });
	// SAFETY: the two defined properties above extend the stub with the
	// observable counters the assertions read; no other member is added.
	return stub as AuthStorage & { markCalls: number; rotateCalls: number };
}

/* ------------------------------------------------------------------ *
 * 1. classifyFailure / resetAtMs / sanitizeApiKey / resolveBaseUrl
 * ------------------------------------------------------------------ */

describe("api — classifyFailure", () => {
	test("400 insufficient credits → quota", () => {
		expect(
			classifyFailure(400, {
				error: { message: "You have insufficient credits to make this request." },
			}),
		).toBe("quota");
	});

	test("429 RATE_LIMITED with rateLimit → quota, resetAtMs ×1000", () => {
		const body = {
			error: { code: "RATE_LIMITED", rateLimit: { window: "weekly", reset: 1_800_000_000 } },
		};
		expect(classifyFailure(429, body)).toBe("quota");
		expect(resetAtMs(body)).toBe(1_800_000_000_000);
	});

	test("429 rate_limit_error → rate-limit (NOT quota)", () => {
		expect(
			classifyFailure(429, { error: { type: "rate_limit_error", message: "Too many requests" } }),
		).toBe("rate-limit");
	});

	test("401 empty body → auth", () => {
		expect(classifyFailure(401, {})).toBe("auth");
	});

	test("bare RATE_LIMITED without a window label → rate-limit (vendor: window must resolve)", () => {
		expect(classifyFailure(undefined, { error: { code: "RATE_LIMITED" } })).toBe("rate-limit");
	});

	test("RATE_LIMITED with a window label → quota", () => {
		expect(
			classifyFailure(undefined, {
				error: { code: "RATE_LIMITED", rateLimit: { window: "fiveHour" } },
			}),
		).toBe("quota");
		expect(
			classifyFailure(429, {
				error: { code: "RATE_LIMITED", message: "usage limit for your plan" },
			}),
		).toBe("quota");
	});

	test("500 empty → other; 403 with message → other", () => {
		expect(classifyFailure(500, {})).toBe("other");
		expect(classifyFailure(403, { error: { message: "nope" } })).toBe("other");
	});
});

describe("api — resetAtMs fallback regex", () => {
	test("falls back to /resets at (ISO)/ when rateLimit absent", () => {
		const iso = "2027-01-02T03:04:05Z";
		const body = { error: { message: `Your usage limit for your plan resets at ${iso}.` } };
		expect(resetAtMs(body)).toBe(Date.parse(iso));
	});

	test("returns undefined when neither rateLimit nor a timestamp is present", () => {
		expect(resetAtMs({ error: { message: "something broke" } })).toBeUndefined();
	});
});

describe("api — sanitizeApiKey", () => {
	test("strips bracketed-paste markers and control chars", () => {
		expect(sanitizeApiKey("\u001b[200~ user_abc \u001b[201~")).toBe("user_abc");
	});

	test("drops ASCII control characters (code ≤ 31 and 127)", () => {
		expect(sanitizeApiKey("user_\u0000\u007fxyz")).toBe("user_xyz");
	});
});

describe("api — resolveBaseUrl", () => {
	test("defaults to prod", () => {
		expect(resolveBaseUrl({})).toBe("https://api.commandcode.ai");
	});

	test("staging env", () => {
		expect(resolveBaseUrl({ COMMANDCODE_API_ENV: "staging" })).toBe(
			"https://staging-api.commandcode.ai",
		);
	});

	test("local env", () => {
		expect(resolveBaseUrl({ COMMANDCODE_API_ENV: "local" })).toBe("http://localhost:9090");
	});

	test("sandbox + COMMANDCODE_API_URL wins", () => {
		expect(resolveBaseUrl({ COMMANDCODE_SANDBOX: "true", COMMANDCODE_API_URL: "http://x" })).toBe(
			"http://x",
		);
	});

	test("COMMANDCODE_API_URL without sandbox is ignored (falls back to prod)", () => {
		expect(resolveBaseUrl({ COMMANDCODE_API_URL: "http://x" })).toBe("https://api.commandcode.ai");
	});

	test("unknown env value defaults to prod", () => {
		expect(resolveBaseUrl({ COMMANDCODE_API_ENV: "garbage" })).toBe("https://api.commandcode.ai");
	});
});

/* ------------------------------------------------------------------ *
 * 2. buildHeaders
 * ------------------------------------------------------------------ */

describe("api — buildHeaders", () => {
	test("contains the full CLI header set", () => {
		const h = buildHeaders("user_test", { sessionId: "sess-1", projectSlug: "0123456789" });
		expect(h.Authorization).toBe("Bearer user_test");
		expect(h["User-Agent"]).toBe("cli");
		expect(h["x-command-code-version"]).toBe("1.14.0");
		expect(h["x-cli-environment"]).toBe("production");
		expect(h["x-session-id"]).toBe("sess-1");
		expect(h["x-project-slug"]).toBe("0123456789");
		expect(h["x-taste-learning"]).toBe("false");
		expect(h["x-co-flag"]).toBe("false");
		expect(h["Content-Type"]).toBe("application/json");
	});
});

describe("catalog — modelsFromApiResponse", () => {
	test("maps a valid two-entry payload with 64k token clamp and model cost", () => {
		const payload = {
			object: "list",
			data: [
				{
					id: "claude-sonnet-5",
					object: "model",
					created: 1787133935,
					owned_by: "command-code",
					name: "Claude Sonnet 5",
					context_length: 1_000_000,
				},
				{
					id: "small-model",
					object: "model",
					created: 1787133935,
					owned_by: "command-code",
					name: "Small Model",
					context_length: 8192,
				},
			],
		};
		const models = modelsFromApiResponse(payload);
		expect(models).toHaveLength(2);

		const [sonnet, small] = models;
		if (!sonnet || !small) throw new Error("expected two mapped models");
		expect(sonnet.id).toBe("claude-sonnet-5");
		expect(sonnet.name).toBe("Claude Sonnet 5");
		expect(sonnet.contextWindow).toBe(1_000_000);
		expect(sonnet.maxTokens).toBe(64_000);
		expect(sonnet.cost).toEqual(costForModel("claude-sonnet-5"));
		const sonnetCaps = capabilitiesForModel("claude-sonnet-5");
		expect(sonnet.reasoning).toBe(sonnetCaps.reasoning);
		expect(sonnet.input).toEqual(sonnetCaps.input);

		expect(small.id).toBe("small-model");
		expect(small.name).toBe("Small Model");
		expect(small.contextWindow).toBe(8192);
		expect(small.maxTokens).toBe(8192);
		expect(small.cost).toEqual(costForModel("small-model"));
		const smallCaps = capabilitiesForModel("small-model");
		expect(small.reasoning).toBe(smallCaps.reasoning);
		expect(small.input).toEqual(smallCaps.input);
	});

	test("maps priced models to real rates and unlisted models to ZERO_COST", () => {
		const payload = {
			object: "list",
			data: [
				{
					id: "claude-sonnet-5",
					name: "Claude Sonnet 5",
					context_length: 1_000_000,
				},
				{
					id: "deepseek/deepseek-v4-flash",
					name: "DeepSeek v4 Flash",
					context_length: 128_000,
				},
				{
					id: "unlisted-model",
					name: "Unlisted Model",
					context_length: 32_000,
				},
			],
		};
		const models = modelsFromApiResponse(payload);
		expect(models).toHaveLength(3);

		expect(models[0]?.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(models[1]?.cost).toEqual({ input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 });
		expect(models[2]?.cost).toEqual(ZERO_COST);
	});

	test("unknown model id defaults to non-reasoning text-only capabilities and zero cost", () => {
		const payload = {
			object: "list",
			data: [
				{
					id: "unknown/futuristic-v9",
					name: "Futuristic V9",
					context_length: 128_000,
				},
			],
		};
		const [model] = modelsFromApiResponse(payload);
		expect(model?.reasoning).toBe(false);
		expect(model?.input).toEqual(["text"]);
		expect(model?.cost).toEqual(ZERO_COST);
	});

	test("throws on non-object body", () => {
		expect(() => modelsFromApiResponse(null)).toThrow(/Expected models response to be an object/);
		expect(() => modelsFromApiResponse("string")).toThrow(
			/Expected models response to be an object/,
		);
		expect(() => modelsFromApiResponse(123)).toThrow(/Expected models response to be an object/);
		expect(() => modelsFromApiResponse(undefined)).toThrow(
			/Expected models response to be an object/,
		);
	});

	test("throws when object is not list", () => {
		expect(() => modelsFromApiResponse({ object: "model", data: [] })).toThrow(
			/Expected models response object to be 'list'/,
		);
		expect(() => modelsFromApiResponse({ object: "error", data: [] })).toThrow(
			/Expected models response object to be 'list'/,
		);
	});

	test("throws on non-array data", () => {
		expect(() => modelsFromApiResponse({ object: "list", data: null })).toThrow(
			/Expected models response data to be an array/,
		);
		expect(() => modelsFromApiResponse({ object: "list", data: "not-an-array" })).toThrow(
			/Expected models response data to be an array/,
		);
		expect(() => modelsFromApiResponse({ object: "list", data: {} })).toThrow(
			/Expected models response data to be an array/,
		);
	});

	test("throws on empty data array", () => {
		expect(() => modelsFromApiResponse({ object: "list", data: [] })).toThrow(
			/Expected models response data array to not be empty/,
		);
	});

	test("throws when entry is missing name or id", () => {
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "model-1", context_length: 32_000 }],
			}),
		).toThrow(/Expected model entry at index 0 to have a non-empty string 'name'/);
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ name: "Model 1", context_length: 32_000 }],
			}),
		).toThrow(/Expected model entry at index 0 to have a non-empty string 'id'/);
	});

	test("throws when entry has zero or non-numeric context_length", () => {
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: 0 }],
			}),
		).toThrow(/Expected model entry at index 0 to have a positive finite 'context_length'/);
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: -100 }],
			}),
		).toThrow(/Expected model entry at index 0 to have a positive finite 'context_length'/);
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: "32000" }],
			}),
		).toThrow(/Expected model entry at index 0 to have a positive finite 'context_length'/);
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: Number.NaN }],
			}),
		).toThrow(/Expected model entry at index 0 to have a positive finite 'context_length'/);
	});
});

describe("catalog — fetchCommandCodeModels", () => {
	test("happy path fetches models sending accept: application/json", async () => {
		const payload = {
			object: "list",
			data: [
				{
					id: "claude-sonnet-5",
					name: "Claude Sonnet 5",
					context_length: 1_000_000,
				},
			],
		};
		let capturedUrl: string | URL | Request = "";
		let capturedHeaders: Record<string, string> | undefined;

		const fetchImpl = asFetchImpl(async (input: URL | RequestInfo, init?: RequestInit) => {
			// SAFETY: the catalog always calls fetch with a string URL, so the
			// recorder's captured target is the string form.
			capturedUrl = input as string;
			// SAFETY: fetch accepts plain objects for headers; the recorder
			// reads only the accept entry the catalog wrote.
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const models = await fetchCommandCodeModels({ fetchImpl });
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe("claude-sonnet-5");
		expect(capturedUrl).toBe("https://api.commandcode.ai/provider/v1/models");
		expect(capturedHeaders?.accept ?? capturedHeaders?.Accept).toBe("application/json");
	});

	test("500 response rejects with a message containing the status", async () => {
		const fetchImpl = asFetchImpl(async () => {
			return new Response("Internal Server Error", {
				status: 500,
				statusText: "Internal Server Error",
			});
		});

		await expect(fetchCommandCodeModels({ fetchImpl })).rejects.toThrow(/500/);
	});

	test("hanging fetch with timeoutMs rejects with timeout message", async () => {
		const fetchImpl = asFetchImpl(async (_input: URL | RequestInfo, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "TimeoutError"));
				});
			});
		});

		await expect(fetchCommandCodeModels({ fetchImpl, timeoutMs: 5 })).rejects.toThrow(
			/timed out|5ms/i,
		);
	});

	test("already-aborted external signal rejects", async () => {
		const controller = new AbortController();
		controller.abort();

		const fetchImpl = asFetchImpl(async () => {
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		});

		await expect(fetchCommandCodeModels({ fetchImpl, signal: controller.signal })).rejects.toThrow(
			/aborted/i,
		);
	});
});

describe("catalog — resolveModelsUrl / resolveModelsTimeoutMs", () => {
	test("MODELS_PATH is the provider models path", () => {
		expect(MODELS_PATH).toBe("/provider/v1/models");
	});

	test("DEFAULT_MODEL_ID is the vendor default", () => {
		expect(DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v4-flash");
	});

	test("resolveModelsUrl defaults to prod catalog URL", () => {
		expect(resolveModelsUrl({})).toBe("https://api.commandcode.ai/provider/v1/models");
		expect(resolveModelsUrl()).toBe("https://api.commandcode.ai/provider/v1/models");
	});

	test("resolveModelsUrl uses staging host when COMMANDCODE_API_ENV is staging", () => {
		expect(resolveModelsUrl({ COMMANDCODE_API_ENV: "staging" })).toBe(
			"https://staging-api.commandcode.ai/provider/v1/models",
		);
	});

	test("resolveModelsUrl respects COMMANDCODE_MODELS_URL override", () => {
		expect(
			resolveModelsUrl({
				COMMANDCODE_MODELS_URL: "https://custom.example.com/custom-models",
				COMMANDCODE_API_ENV: "staging",
			}),
		).toBe("https://custom.example.com/custom-models");
	});

	test("resolveModelsTimeoutMs defaults to 10_000ms", () => {
		expect(resolveModelsTimeoutMs({})).toBe(DEFAULT_MODELS_TIMEOUT_MS);
		expect(resolveModelsTimeoutMs()).toBe(10_000);
	});

	test("resolveModelsTimeoutMs parses valid positive numbers", () => {
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "5000" })).toBe(5_000);
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "12345" })).toBe(12_345);
	});

	test("resolveModelsTimeoutMs ignores garbage and non-positive values", () => {
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "not-a-number" })).toBe(10_000);
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "0" })).toBe(10_000);
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "-500" })).toBe(10_000);
		expect(resolveModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "" })).toBe(10_000);
	});
});

describe("pricing", () => {
	test("costForModel returns exact MODEL_COSTS row for known id and ZERO_COST for unknown id", () => {
		expect(costForModel("claude-sonnet-5")).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		expect(costForModel("deepseek/deepseek-v4-flash")).toEqual({
			input: 0.22,
			output: 0.66,
			cacheRead: 0.007,
			cacheWrite: 0,
		});
		expect(costForModel("unknown/nonexistent-model")).toEqual(ZERO_COST);
	});

	test("MODEL_COSTS contains exactly 56 rows", () => {
		expect(Object.keys(MODEL_COSTS)).toHaveLength(56);
	});

	test("every MODEL_COSTS row has four finite non-negative numbers", () => {
		for (const cost of Object.values(MODEL_COSTS)) {
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				// SAFETY: Number.isFinite is a stricter check than typeof — it
				// rejects NaN/Infinity, which a bare "number" tag would admit.
				expect(Number.isFinite(cost[field])).toBe(true);
				expect(cost[field]).toBeGreaterThanOrEqual(0);
			}
		}
	});

	test("poolside/laguna-s-2.1-free is genuinely all-zero", () => {
		expect(costForModel("poolside/laguna-s-2.1-free")).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("not every row in MODEL_COSTS is zero", () => {
		const nonZeroRows = Object.values(MODEL_COSTS).filter(
			(cost) => cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0,
		);
		expect(nonZeroRows.length).toBeGreaterThan(0);
	});
});

describe("capabilities audit", () => {
	test("MODEL_CAPABILITIES contains exactly 56 rows", () => {
		expect(Object.keys(MODEL_CAPABILITIES)).toHaveLength(56);
	});

	test("MODEL_COSTS and MODEL_CAPABILITIES carry the identical id set", () => {
		const costKeys = Object.keys(MODEL_COSTS).sort();
		const capKeys = Object.keys(MODEL_CAPABILITIES).sort();
		expect(costKeys).toEqual(capKeys);
	});

	test("audit-added ids are present with correct capabilities", () => {
		expect(MODEL_CAPABILITIES["zai-org/GLM-5.3"]).toEqual({ reasoning: true, vision: false });
		expect(capabilitiesForModel("zai-org/GLM-5.3")).toEqual({ reasoning: true, input: ["text"] });

		expect(MODEL_CAPABILITIES["google/gemini-3.7-flash"]).toEqual({
			reasoning: true,
			vision: true,
		});
		expect(capabilitiesForModel("google/gemini-3.7-flash")).toEqual({
			reasoning: true,
			input: ["text", "image"],
		});

		expect(MODEL_CAPABILITIES["xai/grok-4.6"]).toEqual({ reasoning: true, vision: false });
		expect(capabilitiesForModel("xai/grok-4.6")).toEqual({ reasoning: true, input: ["text"] });

		expect(MODEL_CAPABILITIES["Qwen/Qwen3.8-27B"]).toEqual({ reasoning: true, vision: true });
		expect(capabilitiesForModel("Qwen/Qwen3.8-27B")).toEqual({
			reasoning: true,
			input: ["text", "image"],
		});
	});

	test("corrected ids report reasoning true", () => {
		expect(capabilitiesForModel("moonshotai/Kimi-K3").reasoning).toBe(true);
		expect(MODEL_CAPABILITIES["moonshotai/Kimi-K3"]?.reasoning).toBe(true);

		expect(capabilitiesForModel("Qwen/Qwen3.7-Max").reasoning).toBe(true);
		expect(MODEL_CAPABILITIES["Qwen/Qwen3.7-Max"]?.reasoning).toBe(true);

		expect(capabilitiesForModel("tencent/hy3-paid").reasoning).toBe(true);
		expect(MODEL_CAPABILITIES["tencent/hy3-paid"]?.reasoning).toBe(true);

		expect(capabilitiesForModel("nvidia/nemotron-3-ultra-550b-a55b").reasoning).toBe(true);
		expect(MODEL_CAPABILITIES["nvidia/nemotron-3-ultra-550b-a55b"]?.reasoning).toBe(true);
	});

	test("claude-haiku-4-5-20251001 remains non-reasoning with vision", () => {
		expect(MODEL_CAPABILITIES["claude-haiku-4-5-20251001"]).toEqual({
			reasoning: false,
			vision: true,
		});
		expect(capabilitiesForModel("claude-haiku-4-5-20251001")).toEqual({
			reasoning: false,
			input: ["text", "image"],
		});
	});

	test("unknown model id yields non-reasoning text-only capabilities", () => {
		expect(capabilitiesForModel("unknown/nonexistent-model")).toEqual({
			reasoning: false,
			input: ["text"],
		});
	});
});

/* ------------------------------------------------------------------ *
 * 4. stream ndjson decoding
 * ------------------------------------------------------------------ */

describe("stream — ndjson decoding across a mid-line split", () => {
	test("emits start, text_start, text_delta×2, text_end, done with Hello + usage", async () => {
		const [chunkA, chunkB] = splitMidLine();
		const { fetch: fetchImpl } = fetchByBearer({
			"Bearer user_test": () => makeResponse([chunkA, chunkB]),
		});
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);

		const msg = await finalMessage(stream);
		const textPart = msg.content.find((c) => c.type === "text");
		expect(textPart?.type === "text" ? textPart.text : "").toBe("Hello");
		expect(msg.usage.input).toBe(5);
		expect(msg.usage.output).toBe(2);
	});
});

/* ------------------------------------------------------------------ *
 * 5. Rotation
 * ------------------------------------------------------------------ */

describe("stream — quota rotation switches keys and retries", () => {
	test("user_a 400 insufficient credits → markUsageLimitReached once, user_b succeeds", async () => {
		const [chunkA, chunkB] = splitMidLine();
		const { fetch: fetchImpl, calls } = fetchByBearer({
			"Bearer user_a": () =>
				makeResponse([enc('{"error":{"message":"insufficient credits"}}\n')], 400),
			"Bearer user_b": () => makeResponse([chunkA, chunkB]),
		});
		const auth = stubAuthStorage({
			keys: ["user_a", "user_b"],
			markResult: { switched: true },
		});

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const last = events[events.length - 1];

		expect(last?.type).toBe("done");
		expect(auth.markCalls).toBe(1);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.auth).toBe("Bearer user_a");
		expect(calls[1]?.auth).toBe("Bearer user_b");
	});
});

/* ------------------------------------------------------------------ *
 * 6. Exhaustion
 * ------------------------------------------------------------------ */

describe("stream — all keys exhausted fails fast with reset time", () => {
	test("switched:false → one terminal error naming quota exhausted + ISO reset, fetch once", async () => {
		const { fetch: fetchImpl, calls } = fetchByBearer({
			"Bearer user_a": () =>
				makeResponse([enc('{"error":{"message":"insufficient credits"}}\n')], 400),
		});
		const resetAt = 1_800_000_000_000;
		const auth = stubAuthStorage({
			keys: ["user_a"],
			markResult: { switched: false, retryAtMs: resetAt },
		});

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const errEvent = events.find((e) => e.type === "error");

		expect(errEvent?.type).toBe("error");
		// SAFETY: the previous assertion guarantees errEvent is the error event,
		// so its errorMessage field is defined on this branch.
		expect(errEvent?.error.errorMessage).toContain("quota exhausted");
		expect(errEvent?.error.errorMessage).toContain(new Date(resetAt).toISOString());
		expect(auth.markCalls).toBe(1);
		expect(calls).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ *
 * 7. rate-limit does not rotate
 * ------------------------------------------------------------------ */

describe("stream — rate-limit backs off without rotating", () => {
	test("two 429 rate_limit_error then valid stream; never marks/rotates", async () => {
		const [chunkA, chunkB] = splitMidLine();
		let count = 0;
		const calls: { auth: string }[] = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
				// SAFETY: fetch accepts plain objects for headers; the recorder
				// reads only the Authorization entry it wrote.
				const headers = init?.headers as Record<string, string> | undefined;
				calls.push({ auth: headers?.Authorization ?? "" });
				count += 1;
				if (count <= 2) {
					return makeResponse(
						[enc('{"error":{"type":"rate_limit_error","message":"Too many requests"}}\n')],
						429,
					);
				}
				return makeResponse([chunkA, chunkB]);
			},
			{ preconnect: () => undefined },
		);

		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const last = events[events.length - 1];

		expect(last?.type).toBe("done");
		expect(auth.markCalls).toBe(0);
		expect(auth.rotateCalls).toBe(0);
		expect(calls).toHaveLength(3);
	});
});

/* ------------------------------------------------------------------ *
 * 8. native ApiKeyResolver
 * ------------------------------------------------------------------ */

describe("stream — native ApiKeyResolver", () => {
	test("uses the resolver from options.apiKey and never touches AuthStorage", async () => {
		const [chunkA, chunkB] = splitMidLine();
		const { fetch: fetchImpl, calls } = fetchByBearer({
			"Bearer user_resolved": () => makeResponse([chunkA, chunkB]),
		});

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => undefined,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext(), {
			apiKey: (): string => "user_resolved",
		});
		const events = await collectEvents(stream);

		expect(events[events.length - 1]?.type).toBe("done");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.auth).toBe("Bearer user_resolved");
	});

	test("401 walks the a/b/c steps and retries with the rotated key", async () => {
		const [chunkA, chunkB] = splitMidLine();
		const { fetch: fetchImpl, calls } = fetchByBearer({
			"Bearer user_1": () => makeResponse([enc('{"error":{"message":"unauthorized"}}\n')], 401),
			"Bearer user_2": () => makeResponse([chunkA, chunkB]),
		});

		const seen: { lastChance: boolean; previousKey: string | undefined }[] = [];
		const resolver: ApiKeyResolver = ({ lastChance, previousKey }: ApiKeyResolveContext) => {
			seen.push({ lastChance, previousKey });
			return lastChance ? "user_2" : "user_1";
		};

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => undefined,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext(), { apiKey: resolver });
		const events = await collectEvents(stream);

		expect(events[events.length - 1]?.type).toBe("done");
		expect(seen).toEqual([
			{ lastChance: false, previousKey: undefined },
			{ lastChance: false, previousKey: "user_1" },
			{ lastChance: true, previousKey: "user_1" },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.auth).toBe("Bearer user_1");
		expect(calls[1]?.auth).toBe("Bearer user_2");
	});
});

/* ------------------------------------------------------------------ *
 * 8b. cache hit accounting
 * ------------------------------------------------------------------ */

describe("stream — cache hit input split", () => {
	test("subtracts cached tokens from input to compute un-cached input and costs", async () => {
		const ndjson = [
			'{"type":"text-delta","text":"Cached response"}\n',
			'{"type":"finish","finishReason":"end_turn","totalUsage":{"inputTokens":100,"outputTokens":20,"inputTokenDetails":{"cacheReadTokens":60,"cacheWriteTokens":10}}}\n',
		].join("");
		const { fetch: fetchImpl } = fetchByBearer({
			"Bearer user_test": () => makeResponse([enc(ndjson)]),
		});
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel({ id: "claude-sonnet-5" }), makeContext());
		const msg = await finalMessage(stream);

		expect(msg.usage.input).toBe(30);
		expect(msg.usage.output).toBe(20);
		expect(msg.usage.cacheRead).toBe(60);
		expect(msg.usage.cacheWrite).toBe(10);
		expect(msg.usage.totalTokens).toBe(120);

		const rates = costForModel("claude-sonnet-5");
		const expectedInputCost = (30 * rates.input) / 1_000_000;
		const expectedOutputCost = (20 * rates.output) / 1_000_000;
		const expectedCacheReadCost = (60 * rates.cacheRead) / 1_000_000;
		const expectedCacheWriteCost = (10 * rates.cacheWrite) / 1_000_000;
		expect(msg.usage.cost.input).toBeCloseTo(expectedInputCost);
		expect(msg.usage.cost.output).toBeCloseTo(expectedOutputCost);
		expect(msg.usage.cost.cacheRead).toBeCloseTo(expectedCacheReadCost);
		expect(msg.usage.cost.cacheWrite).toBeCloseTo(expectedCacheWriteCost);
		expect(msg.usage.cost.total).toBeCloseTo(
			expectedInputCost + expectedOutputCost + expectedCacheReadCost + expectedCacheWriteCost,
		);
	});
	test("treats cache-exclusive wire shape as additive input without subtracting", async () => {
		const ndjson = [
			'{"type":"text-delta","text":"Cached response"}\n',
			'{"type":"finish","finishReason":"end_turn","totalUsage":{"inputTokens":30,"outputTokens":20,"inputTokenDetails":{"cacheReadTokens":60,"cacheWriteTokens":10}}}\n',
		].join("");
		const { fetch: fetchImpl } = fetchByBearer({
			"Bearer user_test": () => makeResponse([enc(ndjson)]),
		});
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel({ id: "claude-sonnet-5" }), makeContext());
		const msg = await finalMessage(stream);

		expect(msg.usage.input).toBe(30);
		expect(msg.usage.output).toBe(20);
		expect(msg.usage.cacheRead).toBe(60);
		expect(msg.usage.cacheWrite).toBe(10);
		expect(msg.usage.totalTokens).toBe(120);

		const rates = costForModel("claude-sonnet-5");
		const expectedInputCost = (30 * rates.input) / 1_000_000;
		const expectedOutputCost = (20 * rates.output) / 1_000_000;
		const expectedCacheReadCost = (60 * rates.cacheRead) / 1_000_000;
		const expectedCacheWriteCost = (10 * rates.cacheWrite) / 1_000_000;
		expect(msg.usage.cost.input).toBeCloseTo(expectedInputCost);
		expect(msg.usage.cost.output).toBeCloseTo(expectedOutputCost);
		expect(msg.usage.cost.cacheRead).toBeCloseTo(expectedCacheReadCost);
		expect(msg.usage.cost.cacheWrite).toBeCloseTo(expectedCacheWriteCost);
		expect(msg.usage.cost.total).toBeCloseTo(
			expectedInputCost + expectedOutputCost + expectedCacheReadCost + expectedCacheWriteCost,
		);
	});
});

/* ------------------------------------------------------------------ *
 * 8c. metrics stamping
 * ------------------------------------------------------------------ */

describe("stream — metrics stamping", () => {
	test("stamps timestamp, duration, and ttft on successful stream completion", async () => {
		const [chunkA, chunkB] = splitMidLine();
		const { fetch: fetchImpl } = fetchByBearer({
			"Bearer user_test": () => makeResponse([chunkA, chunkB]),
		});
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const before = Date.now();
		const stream = streamFn(makeModel(), makeContext());
		const msg = await finalMessage(stream);
		const after = Date.now();

		expect(msg.timestamp).toBeGreaterThanOrEqual(before);
		expect(msg.timestamp).toBeLessThanOrEqual(after + 100);
		expect(Number.isFinite(msg.duration)).toBe(true);
		expect(Number.isFinite(msg.ttft)).toBe(true);
		expect((msg.duration ?? 0) >= 0).toBe(true);
		expect((msg.ttft ?? 0) >= 0).toBe(true);
	});

	test("stamps timestamp and duration on stream failure", async () => {
		const { fetch: fetchImpl } = fetchByBearer({
			"Bearer user_test": () => makeResponse([enc('{"error":{"message":"bad request"}}\n')], 400),
		});
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const errEvent = events.find((e) => e.type === "error");

		expect(errEvent?.type).toBe("error");
		const duration = errEvent?.type === "error" ? errEvent.error.duration : undefined;
		expect(Number.isFinite(duration)).toBe(true);
		expect((duration ?? 0) >= 0).toBe(true);
	});
});

/* ------------------------------------------------------------------ *
 * 8d. upstream stream-error retry
 * ------------------------------------------------------------------ */

describe("stream — upstream stream-error retry", () => {
	test("retries transient mid-stream error events up to 3 times then fails", async () => {
		let callCount = 0;
		const fetchImpl: typeof fetch = Object.assign(
			async () => {
				callCount += 1;
				return makeResponse([
					enc('{"type":"error","error":{"statusCode":500,"message":"Upstream stream failure"}}\n'),
				]);
			},
			{ preconnect: () => undefined },
		);
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const errEvent = events.find((e) => e.type === "error");

		expect(errEvent?.type).toBe("error");
		expect(callCount).toBe(4);
		expect(errEvent?.type === "error" ? errEvent.error.errorMessage : "").toContain(
			"Upstream stream failure",
		);
	});

	test("emits content once when retried upstream error succeeds on retry", async () => {
		const [chunkA, chunkB] = splitMidLine();
		let callCount = 0;
		const fetchImpl: typeof fetch = Object.assign(
			async () => {
				callCount += 1;
				if (callCount === 1) {
					return makeResponse([
						enc('{"type":"error","error":{"statusCode":503,"message":"Service Unavailable"}}\n'),
					]);
				}
				return makeResponse([chunkA, chunkB]);
			},
			{ preconnect: () => undefined },
		);
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const types = events.map((e) => e.type);

		expect(callCount).toBe(2);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		const msg = await finalMessage(stream);
		const textPart = msg.content.find((c) => c.type === "text");
		expect(textPart?.type === "text" ? textPart.text : "").toBe("Hello");
		expect(Number.isFinite(msg.duration)).toBe(true);
		expect(Number.isFinite(msg.ttft)).toBe(true);
	});

	test("retries network fetch error and succeeds on subsequent attempt", async () => {
		const [chunkA, chunkB] = splitMidLine();
		let callCount = 0;
		const fetchImpl: typeof fetch = Object.assign(
			async () => {
				callCount += 1;
				if (callCount === 1) {
					throw new Error("network fetch failed");
				}
				return makeResponse([chunkA, chunkB]);
			},
			{ preconnect: () => undefined },
		);
		const auth = stubAuthStorage({ keys: ["user_test"] });

		const streamFn = createCommandCodeStream({
			getAuthStorage: () => auth,
			getSessionId: () => "sess-1",
			getProjectSlug: () => "0123456789",
			fetchImpl,
		});

		const stream = streamFn(makeModel(), makeContext());
		const events = await collectEvents(stream);
		const last = events[events.length - 1];

		expect(callCount).toBe(2);
		expect(last?.type).toBe("done");
		const msg = await finalMessage(stream);
		expect(Number.isFinite(msg.duration)).toBe(true);
	});
});

/* ------------------------------------------------------------------ *
 * 9. extension registration
 * ------------------------------------------------------------------ */

/** A session_start handler with the subset of context the plugin reads. */
interface SessionContext {
	modelRegistry: { authStorage: AuthStorage | undefined };
	sessionManager: { getSessionId(): string | undefined };
	cwd: string;
}

/** Event handler signature the plugin's session_start registration uses. */
type SessionHandler = (e: undefined, ctx: SessionContext) => void;

/** The subset of ExtensionAPI the plugin's factory touches. */
interface FakeExtensionAPI {
	on(event: string, handler: SessionHandler): void;
	registerProvider(name: string, config: ProviderConfig): void;
	registerCommand(name: string, options: CommandOptions): void;
}

/** The registerCommand options shape the plugin's factory passes through. */
interface CommandOptions {
	description?: string;
	handler(...args: unknown[]): void;
}

/** Provider identity captured by the fake registration. */
interface ProviderCapture {
	name?: string;
	config?: ProviderConfig;
}

/** Result of {@link fakeExtensionApi}. */
interface FakeExtensionApiResult {
	pi: ExtensionAPI;
	provider: ProviderCapture;
	commands: string[];
	sessionStart: () => SessionHandler | undefined;
}

function fakeExtensionApi(): FakeExtensionApiResult {
	const provider: ProviderCapture = {};
	const commands: string[] = [];
	let onSessionStart: SessionHandler | undefined;
	const base: FakeExtensionAPI = {
		on: (event, handler) => {
			if (event === "session_start") onSessionStart = handler;
		},
		registerProvider: (name, config) => {
			provider.name = name;
			provider.config = config;
		},
		registerCommand: (name) => {
			commands.push(name);
		},
	};
	// SAFETY: the stub implements the three ExtensionAPI members the plugin
	// calls; the cast supplies the members the plugin never touches.
	return { pi: asExtensionApi(base), provider, commands, sessionStart: () => onSessionStart };
}

describe("extension registration", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("registers the provider with native oauth login and dynamic models fetcher", async () => {
		const { pi, provider, commands } = fakeExtensionApi();
		commandCodeProvider(pi);

		expect(provider.name).toBe(PROVIDER_ID);
		expect(provider.config?.api).toBe("commandcode-generate");
		expect(provider.config?.oauth?.name).toBe("Command Code");
		const oauth = provider.config?.oauth;
		// SAFETY: Object.prototype.toString is the box-safe string-tag check;
		// the plugin's oauth login is always an async function after registration.
		expect(oauth ? Object.prototype.toString.call(oauth.login.bind(oauth)) : undefined).toBe(
			"[object AsyncFunction]",
		);
		expect(provider.config?.models).toBeUndefined();
		// SAFETY: Object.prototype.toString is the box-safe string-tag check;
		// the plugin's dynamic-models fetcher is always a function.
		expect(Object.prototype.toString.call(provider.config?.fetchDynamicModels)).toBe(
			"[object Function]",
		);
		expect(commands).toEqual([]);

		const sampleCatalog = {
			object: "list",
			data: [
				{
					id: "claude-sonnet-5",
					object: "model",
					created: 1787133935,
					owned_by: "command-code",
					name: "Claude Sonnet 5",
					context_length: 1_000_000,
				},
			],
		};
		globalThis.fetch = Object.assign(
			async () =>
				new Response(JSON.stringify(sampleCatalog), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			{ preconnect: () => undefined },
		);

		const fetchDynamicModels = provider.config?.fetchDynamicModels;
		expect(fetchDynamicModels).toBeDefined();
		const models = await fetchDynamicModels?.(undefined);
		expect(models).toHaveLength(1);
		expect(models?.[0]?.id).toBe("claude-sonnet-5");
		expect(models?.[0]?.name).toBe("Claude Sonnet 5");
		expect(models?.[0]?.contextWindow).toBe(1_000_000);
		expect(models?.[0]?.maxTokens).toBe(64_000);
	});

	test("session_start wires omp's session id onto the wire header", async () => {
		const { pi, provider, sessionStart } = fakeExtensionApi();
		commandCodeProvider(pi);

		const handler = sessionStart();
		expect(handler).toBeDefined();
		handler?.(undefined, {
			modelRegistry: { authStorage: stubAuthStorage({ keys: ["user_test"] }) },
			sessionManager: { getSessionId: () => "sess-native" },
			cwd: "/tmp/cc-test",
		});

		const [chunkA, chunkB] = splitMidLine();
		const seen: Record<string, string>[] = [];
		globalThis.fetch = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
				// SAFETY: fetch accepts plain objects for headers; the recorder
				// reads only the x-session-id entry the stream wrote.
				seen.push((init?.headers as Record<string, string>) ?? {});
				return makeResponse([chunkA, chunkB]);
			},
			{ preconnect: () => undefined },
		);

		const streamSimple = provider.config?.streamSimple;
		expect(streamSimple).toBeDefined();
		const stream = streamSimple?.(makeModel(), makeContext(), {
			apiKey: (): string => "user_resolved",
		});
		expect(stream).toBeDefined();
		if (!stream) return;
		const events = await collectEvents(stream);

		expect(events[events.length - 1]?.type).toBe("done");
		expect(seen[0]?.["x-session-id"]).toBe("sess-native");
	});
});

describe("commandcode-usage — parseWhoami", () => {
	const whoamiFixture = {
		data: { user: { userName: "alice" }, org: { id: "org_123", login: "my-org" } },
	};
	test("parses whoami fixture", () => {
		expect(parseWhoami(whoamiFixture)).toEqual({
			orgId: "org_123",
			orgLogin: "my-org",
			userName: "alice",
		});
	});
	test("returns null when org id missing", () => {
		expect(parseWhoami({ data: { org: { login: "x" } } })).toBeNull();
		expect(parseWhoami({ data: { user: { userName: "alice" } } })).toBeNull();
		expect(parseWhoami(null)).toBeNull();
		expect(parseWhoami({})).toBeNull();
	});
	test("handles missing optional fields", () => {
		expect(parseWhoami({ data: { org: { id: "org_1" } } })).toEqual({
			orgId: "org_1",
			orgLogin: undefined,
			userName: undefined,
		});
	});
});

describe("commandcode-usage — parseCredits", () => {
	const creditsFixture = {
		data: {
			credits: {
				monthlyCredits: 100,
				purchasedCredits: 20,
				freeCredits: 5,
				planId: "individual-plus",
			},
		},
	};
	test("parses credits fixture", () => {
		expect(parseCredits(creditsFixture)).toEqual({
			monthlyCredits: 100,
			purchasedCredits: 20,
			freeCredits: 5,
			planId: "individual-plus",
		});
	});
	test("returns null when credits absent", () => {
		expect(parseCredits({ data: {} })).toBeNull();
		expect(parseCredits(null)).toBeNull();
		expect(parseCredits({ data: { credits: {} } })).toBeNull();
	});
	test("defaults missing numeric fields to 0", () => {
		expect(parseCredits({ data: { credits: { monthlyCredits: 50 } } })).toEqual({
			monthlyCredits: 50,
			purchasedCredits: 0,
			freeCredits: 0,
			planId: undefined,
		});
	});
});

describe("commandcode-usage — parseSubscription", () => {
	const subFixture = {
		data: {
			data: {
				planId: "individual-plus",
				status: "active",
				currentPeriodStart: "2026-08-01T00:00:00Z",
				currentPeriodEnd: "2026-09-01T00:00:00Z",
			},
		},
	};
	test("parses subscription fixture", () => {
		expect(parseSubscription(subFixture)).toEqual({
			planId: "individual-plus",
			status: "active",
			currentPeriodStart: "2026-08-01T00:00:00Z",
			currentPeriodEnd: "2026-09-01T00:00:00Z",
		});
	});
	test("returns null when empty", () => {
		expect(parseSubscription({ data: {} })).toBeNull();
		expect(parseSubscription(null)).toBeNull();
		expect(parseSubscription({ data: { data: {} } })).toBeNull();
	});
});

describe("commandcode-usage — parseSummary", () => {
	test("parses totalCost and ranks costByModel", () => {
		const raw = {
			data: {
				totalCost: 25,
				costByModel: { "claude-sonnet-4": 15, "gpt-4o": 7, "deepseek-chat": 3, tiny: 0 },
			},
		};
		expect(parseSummary(raw)).toEqual({
			totalCost: 25,
			topModels: ["claude-sonnet-4", "gpt-4o", "deepseek-chat"],
		});
	});
	test("parses without costByModel", () => {
		expect(parseSummary({ data: { totalCost: 12.5 } })).toEqual({
			totalCost: 12.5,
			topModels: undefined,
		});
	});
	test("returns null when totalCost missing", () => {
		expect(parseSummary({ data: {} })).toBeNull();
		expect(parseSummary(null)).toBeNull();
		expect(parseSummary({ data: { costByModel: {} } })).toBeNull();
	});
	test("limits topModels to 3 sorted by cost", () => {
		const raw = {
			data: { totalCost: 10, costByModel: { a: 1, b: 5, c: 3, d: 4, e: 2 } },
		};
		expect(parseSummary(raw)?.topModels).toEqual(["b", "d", "c"]);
	});
});

describe("commandcode-usage — buildUsageReport", () => {
	const whoami = { orgId: "org_123", orgLogin: "my-org", userName: "alice" };
	const credits = {
		monthlyCredits: 100,
		purchasedCredits: 20,
		freeCredits: 5,
		planId: "individual-plus",
	};
	const subscription = {
		planId: "individual-plus",
		status: "active",
		currentPeriodStart: "2026-08-01T00:00:00Z",
		currentPeriodEnd: "2026-09-01T00:00:00Z",
	};
	test("builds credits limit with usedFraction and window", () => {
		const summary = { totalCost: 25, topModels: ["claude-sonnet-4", "gpt-4o"] };
		const report = buildUsageReport({ whoami, credits, subscription, summary, fetchedAt: 1_000 });
		expect(report.provider).toBe(PROVIDER_ID);
		expect(report.fetchedAt).toBe(1_000);
		const creditsLimit = report.limits.find((l) => l.id === "commandcode:credits");
		expect(creditsLimit).toBeDefined();
		expect(creditsLimit?.amount.used).toBe(25);
		expect(creditsLimit?.amount.remaining).toBe(125);
		expect(creditsLimit?.amount.limit).toBe(150);
		expect(creditsLimit?.amount.usedFraction).toBeCloseTo(25 / 150);
		expect(creditsLimit?.amount.unit).toBe("usd");
		expect(creditsLimit?.scope.provider).toBe(PROVIDER_ID);
		expect(creditsLimit?.scope.shared).toBe(true);
		expect(creditsLimit?.window?.id).toBe("period");
		expect(creditsLimit?.window?.resetsAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
		expect(creditsLimit?.status).toBe("ok");
	});
	test("status thresholds: ok, warning, exhausted", () => {
		const ok = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 90, purchasedCredits: 10, freeCredits: 0 },
			subscription,
			summary: { totalCost: 10 },
			fetchedAt: 1,
		});
		expect(ok.limits[0]?.status).toBe("ok");
		const warning = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
			subscription,
			summary: { totalCost: 40 },
			fetchedAt: 1,
		});
		expect(warning.limits[0]?.status).toBe("warning");
		const exhausted = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
			subscription,
			summary: { totalCost: 10 },
			fetchedAt: 1,
		});
		expect(exhausted.limits[0]?.status).toBe("exhausted");
		const unknown = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
			subscription: null,
			summary: null,
			fetchedAt: 1,
		});
		expect(unknown.limits[0]?.status).toBe("unknown");
	});
	test("adds plan limit when planId known and monthlyCredits > 0", () => {
		const report = buildUsageReport({ whoami, credits, subscription, summary: null, fetchedAt: 1 });
		const plan = report.limits.find((l) => l.id === "commandcode:plan:individual-plus");
		expect(plan).toBeDefined();
		expect(plan?.label).toBe(`Plan — ${PLAN_NAMES["individual-plus"]}`);
		expect(plan?.amount.limit).toBe(100);
	});
	test("omits plan limit when monthlyCredits is 0 or plan unknown", () => {
		const noPlan = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 0, purchasedCredits: 10, freeCredits: 0 },
			subscription: null,
			summary: null,
			fetchedAt: 1,
		});
		expect(noPlan.limits.some((l) => l.id.startsWith("commandcode:plan:"))).toBe(false);
	});
	test("adds summary limit and topModels note when totalCost > 0", () => {
		const report = buildUsageReport({
			whoami,
			credits,
			subscription,
			summary: { totalCost: 12.5, topModels: ["a", "b"] },
			fetchedAt: 1,
		});
		const summaryLimit = report.limits.find((l) => l.id === "commandcode:summary");
		expect(summaryLimit?.amount.used).toBe(12.5);
		expect(summaryLimit?.notes?.[0]).toContain("a");
	});
	test("omits summary limit when totalCost is 0 or summary null", () => {
		const r1 = buildUsageReport({ whoami, credits, subscription, summary: null, fetchedAt: 1 });
		expect(r1.limits.some((l) => l.id === "commandcode:summary")).toBe(false);
		const r2 = buildUsageReport({
			whoami,
			credits,
			subscription,
			summary: { totalCost: 0 },
			fetchedAt: 1,
		});
		expect(r2.limits.some((l) => l.id === "commandcode:summary")).toBe(false);
	});
	test("metadata and notes", () => {
		const report = buildUsageReport({
			whoami,
			credits,
			subscription,
			summary: null,
			fetchedAt: 999,
		});
		expect(report.metadata?.endpoint).toBe("commandcode");
		expect(report.metadata?.account).toBe("alice");
		expect(report.metadata?.planId).toBe("individual-plus");
		expect(report.notes?.[0]).toContain("Credits are Command Code");
	});
	test("falls back to orgLogin then orgId for account label", () => {
		const r1 = buildUsageReport({
			whoami: { orgId: "org_1", orgLogin: "my-org" },
			credits,
			subscription: null,
			summary: null,
			fetchedAt: 1,
		});
		expect(r1.metadata?.account).toBe("my-org");
		const r2 = buildUsageReport({
			whoami: { orgId: "org_1" },
			credits,
			subscription: null,
			summary: null,
			fetchedAt: 1,
		});
		expect(r2.metadata?.account).toBe("org_1");
	});
	test("emits 7d and 5h windowId limits sharing the credits usedFraction", () => {
		const summary = { totalCost: 25, topModels: ["claude-sonnet-4", "gpt-4o"] };
		const report = buildUsageReport({ whoami, credits, subscription, summary, fetchedAt: 1_000 });
		const creditsLimit = report.limits.find((l) => l.id === "commandcode:credits");
		const w7d = report.limits.find((l) => l.id === "commandcode:usage:7d");
		const w5h = report.limits.find((l) => l.id === "commandcode:usage:5h");
		expect(w7d).toBeDefined();
		expect(w5h).toBeDefined();
		expect(w7d?.scope.windowId).toBe("7d");
		expect(w5h?.scope.windowId).toBe("5h");
		expect(w7d?.scope.provider).toBe(PROVIDER_ID);
		expect(w7d?.scope.orgId).toBe("org_123");
		expect(w7d?.label).toBe("Command Code Usage (7d)");
		expect(w5h?.label).toBe("Command Code Usage (5h)");
		expect(w7d?.amount.usedFraction).toBe(creditsLimit?.amount.usedFraction);
		expect(w5h?.amount.usedFraction).toBe(creditsLimit?.amount.usedFraction);
		expect(w7d?.amount.unit).toBe("usd");
		expect(w7d?.status).toBe(creditsLimit?.status);
		expect(w7d?.window?.resetsAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
		expect(report.limits.some((l) => l.id === "commandcode:credits")).toBe(true);
		expect(report.limits.some((l) => l.id.startsWith("commandcode:plan:"))).toBe(true);
		expect(report.limits.some((l) => l.id === "commandcode:summary")).toBe(true);
	});
	test("omits windowId limits when usedFraction is undefined", () => {
		const report = buildUsageReport({
			whoami,
			credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
			subscription: null,
			summary: null,
			fetchedAt: 1,
		});
		expect(report.limits.some((l) => l.scope.windowId === "7d" || l.scope.windowId === "5h")).toBe(
			false,
		);
	});
});

describe("commandcode-usage — fetchCommandCodeUsage", () => {
	function jsonResponse<T>(body: string | T, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
	function makeFetch(
		routes: Record<string, unknown>,
		seen: { url: string; signal: AbortSignal | undefined }[] = [],
	): typeof fetch {
		return Object.assign(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url = urlOf(input);
				// SAFETY: the harness passes an AbortSignal through init.signal;
				// the recorder asserts on that exact object later.
				seen.push({ url, signal: init?.signal as AbortSignal | undefined });
				if (url.includes("/alpha/whoami")) return jsonResponse(routes["whoami"]);
				if (url.includes("/alpha/billing/credits")) return jsonResponse(routes["credits"]);
				if (url.includes("/alpha/billing/subscriptions"))
					return jsonResponse(routes["subscriptions"]);
				if (url.includes("/alpha/usage/summary"))
					return jsonResponse(routes["summary"] ?? { data: { totalCost: 0 } });
				return jsonResponse({}, 404);
			},
			{ preconnect: () => undefined },
		);
	}
	test("fetches 4 endpoints and builds report", async () => {
		const seen: { url: string; signal: AbortSignal | undefined }[] = [];
		const fetchImpl = makeFetch(
			{
				whoami: { data: { user: { userName: "alice" }, org: { id: "org_123", login: "my-org" } } },
				credits: {
					data: {
						credits: {
							monthlyCredits: 100,
							purchasedCredits: 20,
							freeCredits: 5,
							planId: "individual-plus",
						},
					},
				},
				subscriptions: {
					data: {
						data: {
							planId: "individual-plus",
							status: "active",
							currentPeriodStart: "2026-08-01T00:00:00Z",
							currentPeriodEnd: "2026-09-01T00:00:00Z",
						},
					},
				},
				summary: { data: { totalCost: 25, costByModel: { a: 10, b: 5 } } },
			},
			seen,
		);
		const report = await fetchCommandCodeUsage({
			apiKey: "user_test",
			baseUrl: "https://api.commandcode.ai",
			fetchImpl,
		});
		expect(report).not.toBeNull();
		expect(report?.provider).toBe(PROVIDER_ID);
		expect(report?.limits.length).toBeGreaterThanOrEqual(1);
		expect(seen.some((s) => s.url.includes("/alpha/whoami"))).toBe(true);
		expect(seen.some((s) => s.url.includes("/alpha/billing/credits"))).toBe(true);
	});
	test("returns null when whoami fails", async () => {
		const fetchImpl = makeFetch({
			whoami: {},
			credits: { data: { credits: { monthlyCredits: 100 } } },
			subscriptions: { data: { data: {} } },
		});
		expect(
			await fetchCommandCodeUsage({
				apiKey: "k",
				baseUrl: "https://api.commandcode.ai",
				fetchImpl,
			}),
		).toBeNull();
	});
	test("returns null when credits fails", async () => {
		const fetchImpl = makeFetch({
			whoami: { data: { org: { id: "org_1" } } },
			credits: {},
			subscriptions: { data: { data: {} } },
		});
		expect(
			await fetchCommandCodeUsage({
				apiKey: "k",
				baseUrl: "https://api.commandcode.ai",
				fetchImpl,
			}),
		).toBeNull();
	});
	test("forwards AbortSignal to every request", async () => {
		const controller = new AbortController();
		const seen: { url: string; signal: AbortSignal | undefined }[] = [];
		const fetchImpl = makeFetch(
			{
				whoami: { data: { org: { id: "org_1" } } },
				credits: { data: { credits: { monthlyCredits: 10 } } },
				subscriptions: { data: { data: { currentPeriodStart: "2026-08-01T00:00:00Z" } } },
				summary: { data: { totalCost: 1 } },
			},
			seen,
		);
		await fetchCommandCodeUsage({
			apiKey: "k",
			baseUrl: "https://api.commandcode.ai",
			fetchImpl,
			signal: controller.signal,
		});
		for (const entry of seen) expect(entry.signal).toBe(controller.signal);
	});
	test("fetchCommandCodeUsageReports wraps single report", async () => {
		const fetchImpl = makeFetch({
			whoami: { data: { org: { id: "org_1" } } },
			credits: { data: { credits: { monthlyCredits: 10 } } },
			subscriptions: { data: { data: {} } },
		});
		const reports = await fetchCommandCodeUsageReports({
			apiKey: "k",
			baseUrl: "https://api.commandcode.ai",
			fetchImpl,
		});
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.provider).toBe(PROVIDER_ID);
	});
});

describe("commandcode-usage — mergeCommandCodeReport", () => {
	function fakeReport(provider: string, id: string): UsageReport {
		return {
			provider,
			fetchedAt: 1,
			limits: [{ id, label: id, scope: { provider }, amount: { unit: "usd" } }],
		};
	}
	test("appends when no existing commandcode report", () => {
		const other = fakeReport("anthropic", "a:1");
		const cc = fakeReport(PROVIDER_ID, "commandcode:credits");
		expect(mergeCommandCodeReport([other], cc)).toEqual([other, cc]);
	});
	test("dedupes by provider id — replaces existing commandcode report", () => {
		const stale = fakeReport(PROVIDER_ID, "commandcode:credits");
		const other = fakeReport("anthropic", "a:1");
		const fresh = fakeReport(PROVIDER_ID, "commandcode:credits");
		const merged = mergeCommandCodeReport([other, stale], fresh);
		expect(merged).toHaveLength(2);
		expect(merged?.filter((r) => r.provider === PROVIDER_ID)).toHaveLength(1);
		expect(merged?.find((r) => r.provider === PROVIDER_ID)).toBe(fresh);
	});
	test("returns existing when report is null", () => {
		const other = fakeReport("anthropic", "a:1");
		expect(mergeCommandCodeReport([other], null)).toEqual([other]);
		expect(mergeCommandCodeReport(null, null)).toBeNull();
	});
	test("wraps null existing into single-element array", () => {
		const cc = fakeReport(PROVIDER_ID, "commandcode:credits");
		expect(mergeCommandCodeReport(null, cc)).toEqual([cc]);
	});
});

describe("commandcode-usage — extension fetchUsageReports wrapper", () => {
	function makeUsageFetch<T>(body: string | T, status = 200): typeof fetch {
		return Object.assign(
			async (input: URL | RequestInfo) => {
				const url = urlOf(input);
				if (url.includes("/alpha/whoami"))
					return new Response(
						JSON.stringify({ data: { org: { id: "org_1" }, user: { userName: "alice" } } }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				if (url.includes("/alpha/billing/credits"))
					return new Response(
						JSON.stringify({
							data: { credits: { monthlyCredits: 100, purchasedCredits: 10, freeCredits: 0 } },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				if (url.includes("/alpha/billing/subscriptions"))
					return new Response(
						JSON.stringify({
							data: {
								data: {
									planId: "individual-plus",
									status: "active",
									currentPeriodStart: "2026-08-01T00:00:00Z",
									currentPeriodEnd: "2026-09-01T00:00:00Z",
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				if (url.includes("/alpha/usage/summary"))
					return new Response(JSON.stringify(body), {
						status,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(JSON.stringify({}), { status: 404 });
			},
			{ preconnect: () => undefined },
		);
	}
	test("merges commandcode report with other providers and dedupes", async () => {
		const origReport: UsageReport = { provider: "anthropic", fetchedAt: 1, limits: [] };
		const staleCC: UsageReport = { provider: PROVIDER_ID, fetchedAt: 1, limits: [] };
		const storage = asAuthStorage({
			getApiKey: async () => "user_test",
			fetchUsageReports: async (): Promise<UsageReport[] | null> => [origReport, staleCC],
		});
		const realFetch = globalThis.fetch;
		globalThis.fetch = makeUsageFetch({ data: { totalCost: 5 } });
		try {
			const fakePi = asExtensionApi({
				on: (event: string, fn: SessionHandler) => {
					if (event === "session_start")
						fn(undefined, {
							modelRegistry: { authStorage: storage },
							sessionManager: { getSessionId: () => "sess-1" },
							cwd: "/tmp/cc-test",
						});
				},
				registerProvider: () => {},
				registerCommand: () => {},
			});
			commandCodeProvider(fakePi);
			const reports = await storage.fetchUsageReports();
			expect(reports).not.toBeNull();
			expect(reports?.some((r) => r.provider === "anthropic")).toBe(true);
			expect(reports?.filter((r) => r.provider === PROVIDER_ID)).toHaveLength(1);
			expect(reports?.find((r) => r.provider === PROVIDER_ID)?.limits[0]?.id).toBe(
				"commandcode:credits",
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("wrapper adds commandcode report to a host-only report list", async () => {
		const origReport: UsageReport = { provider: "anthropic", fetchedAt: 1, limits: [] };
		const storage = asAuthStorage({
			getApiKey: async () => "user_test",
			fetchUsageReports: async (): Promise<UsageReport[] | null> => [origReport],
		});
		const realFetch = globalThis.fetch;
		globalThis.fetch = makeUsageFetch({ data: { totalCost: 5 } });
		try {
			const fakePi = asExtensionApi({
				on: (event: string, fn: SessionHandler) => {
					if (event === "session_start")
						fn(undefined, {
							modelRegistry: { authStorage: storage },
							sessionManager: { getSessionId: () => "sess-1" },
							cwd: "/tmp/cc-test",
						});
				},
				registerProvider: () => {},
				registerCommand: () => {},
			});
			commandCodeProvider(fakePi);
			const reports = await storage.fetchUsageReports();
			expect(reports).not.toBeNull();
			expect(reports?.some((r) => r.provider === "anthropic")).toBe(true);
			expect(reports?.some((r) => r.provider === PROVIDER_ID)).toBe(true);
			expect(reports?.filter((r) => r.provider === PROVIDER_ID)).toHaveLength(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("preserves other reports when commandcode fetch fails", async () => {
		const origReport: UsageReport = { provider: "anthropic", fetchedAt: 1, limits: [] };
		const storage = asAuthStorage({
			getApiKey: async () => undefined,
			fetchUsageReports: async (): Promise<UsageReport[] | null> => [origReport],
		});
		const fakePi = asExtensionApi({
			on: (event: string, fn: SessionHandler) => {
				if (event === "session_start")
					fn(undefined, {
						modelRegistry: { authStorage: storage },
						sessionManager: { getSessionId: () => "sess-1" },
						cwd: "/tmp/cc-test",
					});
			},
			registerProvider: () => {},
			registerCommand: () => {},
		});
		commandCodeProvider(fakePi);
		const reports = await storage.fetchUsageReports();
		expect(reports).toEqual([origReport]);
	});
	test("respects baseUrlResolver override", async () => {
		const seenUrls: string[] = [];
		const storage = asAuthStorage({
			getApiKey: async () => "user_test",
			fetchUsageReports: async (): Promise<UsageReport[] | null> => [],
		});
		const customBase = "https://custom.example.com";
		const realFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (input: URL | RequestInfo) => {
				seenUrls.push(urlOf(input));
				const url = urlOf(input);
				if (url.includes("/alpha/whoami"))
					return new Response(JSON.stringify({ data: { org: { id: "org_1" } } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				if (url.includes("/alpha/billing/credits"))
					return new Response(JSON.stringify({ data: { credits: { monthlyCredits: 10 } } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				if (url.includes("/alpha/billing/subscriptions"))
					return new Response(JSON.stringify({ data: { data: {} } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(JSON.stringify({ data: { totalCost: 0 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			{ preconnect: () => undefined },
		);
		try {
			const fakePi = asExtensionApi({
				on: (event: string, fn: SessionHandler) => {
					if (event === "session_start")
						fn(undefined, {
							modelRegistry: { authStorage: storage },
							sessionManager: { getSessionId: () => "sess-1" },
							cwd: "/tmp/cc-test",
						});
				},
				registerProvider: () => {},
				registerCommand: () => {},
			});
			commandCodeProvider(fakePi);
			await storage.fetchUsageReports({
				baseUrlResolver: (p: string) => (p === PROVIDER_ID ? customBase : undefined),
			});
			expect(seenUrls.some((u) => u.startsWith(customBase))).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("does not re-wrap on second session_start — commandcode fetch runs once per call", async () => {
		let originCalls = 0;
		const originReports: UsageReport[] = [{ provider: "anthropic", fetchedAt: 1, limits: [] }];
		const storage = asAuthStorage({
			getApiKey: async () => "user_test",
			fetchUsageReports: async (): Promise<UsageReport[] | null> => {
				originCalls += 1;
				return originReports;
			},
		});
		let commandcodeFetches = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (input: URL | RequestInfo) => {
				commandcodeFetches += 1;
				const url = urlOf(input);
				if (url.includes("/alpha/whoami"))
					return new Response(JSON.stringify({ data: { org: { id: "org_1" } } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				if (url.includes("/alpha/billing/credits"))
					return new Response(JSON.stringify({ data: { credits: { monthlyCredits: 10 } } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				if (url.includes("/alpha/billing/subscriptions"))
					return new Response(JSON.stringify({ data: { data: {} } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(JSON.stringify({ data: { totalCost: 0 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			{ preconnect: () => undefined },
		);
		try {
			const makePi = (): ExtensionAPI =>
				asExtensionApi({
					on: (event: string, fn: SessionHandler) => {
						if (event === "session_start")
							fn(undefined, {
								modelRegistry: { authStorage: storage },
								sessionManager: { getSessionId: () => "sess-1" },
								cwd: "/tmp/cc-test",
							});
					},
					registerProvider: () => {},
					registerCommand: () => {},
				});
			commandCodeProvider(makePi());
			commandCodeProvider(makePi());
			await storage.fetchUsageReports();
			expect(originCalls).toBe(1);
			expect(commandcodeFetches).toBe(3);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("provider parity — catalog, headers, and login", () => {
	test("fetchCommandCodeModels sends authorization and standard headers when apiKey is present", async () => {
		let capturedHeaders: Record<string, string> | undefined;
		const fetchImpl = asFetchImpl(async (_input: URL | RequestInfo, init?: RequestInit) => {
			// SAFETY: init.headers is a plain header record in tests.
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							context_length: 1_000_000,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await fetchCommandCodeModels({ fetchImpl, apiKey: "user_catalog_key" });
		expect(models).toHaveLength(1);
		expect(capturedHeaders?.authorization ?? capturedHeaders?.Authorization).toBe(
			"Bearer user_catalog_key",
		);
		expect(capturedHeaders?.["user-agent"] ?? capturedHeaders?.["User-Agent"]).toBe("cli");
		expect(capturedHeaders?.accept ?? capturedHeaders?.Accept).toBe("application/json");
	});

	test("fetchCommandCodeModels omits Authorization header when apiKey is undefined", async () => {
		let capturedHeaders: Record<string, string> | undefined;
		const fetchImpl = asFetchImpl(async (_input: URL | RequestInfo, init?: RequestInit) => {
			// SAFETY: init.headers is a plain header record in tests.
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							context_length: 1_000_000,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		await fetchCommandCodeModels({ fetchImpl });
		expect(capturedHeaders?.authorization ?? capturedHeaders?.Authorization).toBeUndefined();
		expect(capturedHeaders?.["user-agent"] ?? capturedHeaders?.["User-Agent"]).toBe("cli");
		expect(capturedHeaders?.accept ?? capturedHeaders?.Accept).toBe("application/json");
	});

	test("loginWithCommandCode provides launchUrl when callback server is active", async () => {
		let capturedUrl: string | undefined;
		let capturedLaunchUrl: string | undefined;
		const abortController = new AbortController();

		const promptPromise = loginWithCommandCode({
			onAuth(info) {
				capturedUrl = info.url;
				capturedLaunchUrl = info.launchUrl;
				abortController.abort();
			},
			onPrompt: () => new Promise<string>(() => {}),
			signal: abortController.signal,
		});

		await expect(promptPromise).rejects.toThrow(/cancelled|aborted/i);
		expect(capturedUrl).toContain("https://commandcode.ai/studio/auth/cli");
		expect(
			capturedLaunchUrl === undefined || /^http:\/\/localhost:\d+\/$/.test(capturedLaunchUrl),
		).toBe(true);
	});
});
