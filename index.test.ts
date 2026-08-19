import { afterEach, describe, expect, test } from "bun:test";
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
import { capabilitiesForModel, DEFAULT_MODEL_ID } from "./src/models";
import { createCommandCodeStream } from "./src/stream";

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
		api: "commandcode-generate" as Api,
		provider: "commandcode",
		baseUrl: "https://api.commandcode.ai",
		reasoning: overrides.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

/** A recording fetch that routes by Authorization bearer. */
function fetchByBearer(routes: Record<string, () => Response>): {
	fetch: typeof fetch;
	calls: { auth: string; body: string }[];
} {
	const calls: { auth: string; body: string }[] = [];
	const fn: typeof fetch = Object.assign(
		async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			const auth = headers?.Authorization ?? "";
			const bodyText = typeof init?.body === "string" ? init.body : "";
			calls.push({ auth, body: bodyText });
			const factory = routes[auth];
			if (!factory) throw new Error(`unexpected bearer ${auth} for ${String(input)}`);
			return factory();
		},
		{ preconnect: () => undefined },
	);
	return { fetch: fn, calls };
}

/** The subset of AuthStorage the stream exercises. Test double for a large
 *  third-party interface (~30 methods) — only these five are touched. */
interface StreamAuthStorage {
	getApiKey(provider: string, sessionId?: string): Promise<string | undefined>;
	markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: unknown,
	): Promise<UsageLimitMarkResult>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: unknown,
	): Promise<boolean>;
	listStoredCredentials(provider?: string): StoredAuthCredential[];
	resolver(provider: string, options?: unknown): ApiKeyResolver;
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
	const stub = base as AuthStorage;
	Object.defineProperty(stub, "markCalls", { get: () => counts.mark });
	Object.defineProperty(stub, "rotateCalls", { get: () => counts.rotate });
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
	test("maps a valid two-entry payload with 64k token clamp and zero cost", () => {
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

		const sonnet = models[0]!;
		expect(sonnet.id).toBe("claude-sonnet-5");
		expect(sonnet.name).toBe("Claude Sonnet 5");
		expect(sonnet.contextWindow).toBe(1_000_000);
		expect(sonnet.maxTokens).toBe(64_000);
		expect(sonnet.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const sonnetCaps = capabilitiesForModel("claude-sonnet-5");
		expect(sonnet.reasoning).toBe(sonnetCaps.reasoning);
		expect(sonnet.input).toEqual(sonnetCaps.input);

		const small = models[1]!;
		expect(small.id).toBe("small-model");
		expect(small.name).toBe("Small Model");
		expect(small.contextWindow).toBe(8192);
		expect(small.maxTokens).toBe(8192);
		expect(small.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const smallCaps = capabilitiesForModel("small-model");
		expect(small.reasoning).toBe(smallCaps.reasoning);
		expect(small.input).toEqual(smallCaps.input);
	});

	test("unknown model id defaults to non-reasoning text-only capabilities", () => {
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
	});

	test("throws on non-object body", () => {
		expect(() => modelsFromApiResponse(null)).toThrow();
		expect(() => modelsFromApiResponse("string")).toThrow();
		expect(() => modelsFromApiResponse(123)).toThrow();
		expect(() => modelsFromApiResponse(undefined)).toThrow();
	});

	test("throws when object is not list", () => {
		expect(() => modelsFromApiResponse({ object: "model", data: [] })).toThrow();
		expect(() => modelsFromApiResponse({ object: "error", data: [] })).toThrow();
	});

	test("throws on non-array data", () => {
		expect(() => modelsFromApiResponse({ object: "list", data: null })).toThrow();
		expect(() => modelsFromApiResponse({ object: "list", data: "not-an-array" })).toThrow();
		expect(() => modelsFromApiResponse({ object: "list", data: {} })).toThrow();
	});

	test("throws on empty data array", () => {
		expect(() => modelsFromApiResponse({ object: "list", data: [] })).toThrow();
	});

	test("throws when entry is missing name or id", () => {
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "model-1", context_length: 32_000 }],
			}),
		).toThrow();
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ name: "Model 1", context_length: 32_000 }],
			}),
		).toThrow();
	});

	test("throws when entry has zero or non-numeric context_length", () => {
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: 0 }],
			}),
		).toThrow();
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: -100 }],
			}),
		).toThrow();
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: "32000" }],
			}),
		).toThrow();
		expect(() =>
			modelsFromApiResponse({
				object: "list",
				data: [{ id: "m1", name: "M1", context_length: Number.NaN }],
			}),
		).toThrow();
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

		const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
			capturedUrl = input as string;
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const models = await fetchCommandCodeModels({ fetchImpl });
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe("claude-sonnet-5");
		expect(capturedUrl).toBe("https://api.commandcode.ai/provider/v1/models");
		expect(capturedHeaders?.accept ?? capturedHeaders?.Accept).toBe("application/json");
	});

	test("500 response rejects with a message containing the status", async () => {
		const fetchImpl = (async () => {
			return new Response("Internal Server Error", {
				status: 500,
				statusText: "Internal Server Error",
			});
		}) as unknown as typeof fetch;

		await expect(fetchCommandCodeModels({ fetchImpl })).rejects.toThrow(/500/);
	});

	test("hanging fetch with timeoutMs rejects with timeout message", async () => {
		const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "TimeoutError"));
				});
			});
		}) as unknown as typeof fetch;

		await expect(fetchCommandCodeModels({ fetchImpl, timeoutMs: 5 })).rejects.toThrow(
			/timed out|5ms/i,
		);
	});

	test("already-aborted external signal rejects", async () => {
		const controller = new AbortController();
		controller.abort();

		const fetchImpl = (async () => {
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		await expect(
			fetchCommandCodeModels({ fetchImpl, signal: controller.signal }),
		).rejects.toThrow();
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
		if (errEvent?.type === "error") {
			expect(errEvent.error.errorMessage).toContain("quota exhausted");
			expect(errEvent.error.errorMessage).toContain(new Date(resetAt).toISOString());
		}
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
 * 9. extension registration
 * ------------------------------------------------------------------ */

/** The subset of ExtensionAPI the plugin's factory touches. */
interface FakeExtensionAPI {
	on(event: string, handler: (e: unknown, ctx: unknown) => void): void;
	registerProvider(name: string, config: ProviderConfig): void;
	registerCommand(name: string, options: unknown): void;
}

function fakeExtensionApi(): {
	pi: ExtensionAPI;
	provider: { name?: string; config?: ProviderConfig };
	commands: string[];
	sessionStart(): ((e: unknown, ctx: unknown) => void) | undefined;
} {
	const provider: { name?: string; config?: ProviderConfig } = {};
	const commands: string[] = [];
	let onSessionStart: ((e: unknown, ctx: unknown) => void) | undefined;
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
	return { pi: base as ExtensionAPI, provider, commands, sessionStart: () => onSessionStart };
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
		expect(typeof provider.config?.oauth?.login).toBe("function");
		expect(provider.config?.models).toBeUndefined();
		expect(typeof provider.config?.fetchDynamicModels).toBe("function");
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
