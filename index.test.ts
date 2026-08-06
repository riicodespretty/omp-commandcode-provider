import { describe, expect, test } from "bun:test";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AuthStorage,
	Context,
	Model,
	StoredAuthCredential,
	UsageLimitMarkResult,
} from "@oh-my-pi/pi-ai";

import {
	buildHeaders,
	classifyFailure,
	resetAtMs,
	resolveBaseUrl,
	sanitizeApiKey,
} from "./src/api";
import { appendKey, readPool, removeKeyAt } from "./src/keys";
import { COMMAND_CODE_MODELS, DEFAULT_MODEL_ID } from "./src/models";
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
 *  third-party interface (~30 methods) — only these four are touched. */
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

/* ------------------------------------------------------------------ *
 * 3. models catalog
 * ------------------------------------------------------------------ */

describe("models catalog", () => {
	test("has 52 entries", () => {
		expect(COMMAND_CODE_MODELS).toHaveLength(52);
	});

	test("omits the three vendor-hidden ids", () => {
		const ids = COMMAND_CODE_MODELS.map((m) => m.id);
		expect(ids).not.toContain("MiniMaxAI/MiniMax-M3-Free");
		expect(ids).not.toContain("tencent/Hy3");
		expect(ids).not.toContain("inclusionai/ling-3.0-flash-free");
	});

	test("every entry has maxTokens 64000 and zero cost", () => {
		for (const m of COMMAND_CODE_MODELS) {
			expect(m.maxTokens).toBe(64_000);
			expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	test("vision models include image, non-vision do not (spot checks)", () => {
		const byId = new Map(COMMAND_CODE_MODELS.map((m) => [m.id, m]));
		const sonnet = byId.get("claude-sonnet-5");
		expect(sonnet?.input).toContain("image");
		const deepseek = byId.get("deepseek/deepseek-v4-flash");
		expect(deepseek?.input).not.toContain("image");
		expect(deepseek?.input).toEqual(["text"]);
	});

	test("DEFAULT_MODEL_ID is the vendor default", () => {
		expect(DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v4-flash");
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
 * 8. keys pool
 * ------------------------------------------------------------------ */

/** The subset of AuthStorage the keys module exercises. */
interface PoolAuthStorage {
	listStoredCredentials(provider?: string): StoredAuthCredential[];
	set(provider: string, credential: unknown): Promise<void>;
	removeCredential(provider: string, credentialId: number): Promise<boolean>;
}

/** A minimal in-memory AuthStorage backed by an array, for the keys tests. */
function poolAuthStorage(): AuthStorage & { _rows: StoredAuthCredential[] } {
	let nextId = 1;
	const _rows: StoredAuthCredential[] = [];
	const base: PoolAuthStorage = {
		listStoredCredentials: (provider?: string) =>
			_rows.filter((r) => provider === undefined || r.provider === provider),
		set: async (provider, entry) => {
			const creds = Array.isArray(entry) ? entry : [entry];
			// Replace the provider's whole entry (read-modify-write contract).
			for (let i = _rows.length - 1; i >= 0; i--) {
				if (_rows[i]?.provider === provider) _rows.splice(i, 1);
			}
			for (const c of creds) {
				const cred = c as { type: "api_key"; key: string; source?: string };
				_rows.push({
					id: nextId++,
					provider,
					credential: { type: "api_key", key: cred.key, source: "login" },
					disabledCause: null,
				});
			}
		},
		removeCredential: async (provider, credentialId) => {
			const idx = _rows.findIndex((r) => r.provider === provider && r.id === credentialId);
			if (idx === -1) return false;
			_rows.splice(idx, 1);
			return true;
		},
	};
	const stub = base as AuthStorage;
	Object.defineProperty(stub, "_rows", { get: () => _rows });
	return stub as AuthStorage & { _rows: StoredAuthCredential[] };
}

describe("keys — pool management", () => {
	test("appendKey twice then readPool returns both in insertion order", async () => {
		const auth = poolAuthStorage();
		await appendKey(auth, "user_one");
		await appendKey(auth, "user_two");
		const pool = readPool(auth);
		expect(pool).toHaveLength(2);
		expect(pool[0]?.key).toBe("user_one");
		expect(pool[1]?.key).toBe("user_two");
	});

	test("appendKey duplicate throws", async () => {
		const auth = poolAuthStorage();
		await appendKey(auth, "user_dup");
		await expect(appendKey(auth, "user_dup")).rejects.toThrow(/already stored/i);
	});

	test("removeKeyAt(1) returns true and shrinks the pool", async () => {
		const auth = poolAuthStorage();
		await appendKey(auth, "user_a");
		await appendKey(auth, "user_b");
		expect(await removeKeyAt(auth, 1)).toBe(true);
		const pool = readPool(auth);
		expect(pool).toHaveLength(1);
		expect(pool[0]?.key).toBe("user_b");
	});

	test("removeKeyAt(99) returns false when out of range", async () => {
		const auth = poolAuthStorage();
		await appendKey(auth, "user_a");
		expect(await removeKeyAt(auth, 99)).toBe(false);
		expect(readPool(auth)).toHaveLength(1);
	});
});
