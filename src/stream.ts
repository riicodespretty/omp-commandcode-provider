import type {
	Api,
	ApiKey,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthStorage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";

import { AUTH_RETRY_STEPS, isApiKeyResolver, resolveApiKeyOnce } from "./auth-retry";
import { createAssistantMessageEventStream } from "./event-stream";
import type { AssistantMessageEventStream as LocalAssistantMessageEventStream } from "./event-stream";

import {
	API_ID,
	buildHeaders,
	classifyFailure,
	DEFAULT_MAX_TOKENS,
	PROVIDER_ID,
	resetAtMs,
	resolveBaseUrl,
} from "./api";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	isObjectLike,
	type JsonObject,
	type JsonValue,
} from "./guards";
import { costForModel } from "./pricing";

const MAX_KEY_ATTEMPTS = 4;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const MAX_UPSTREAM_RETRIES = 3;
const NO_KEY_MESSAGE = "No Command Code API key. Run /login and pick Command Code.";
const MISSING_FINISH_MESSAGE = "Command Code stream ended without a finish event";

type WireContentPart =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| {
			type: "tool-result";
			toolCallId: string;
			toolName: string;
			output: { type: "text"; value: string };
			isError: boolean;
	  };

type WireMessage = { role: string; content: WireContentPart[] };

type WireParams = {
	model: string;
	messages: WireMessage[];
	tools?: { name: string; description: string; input_schema: unknown }[];
	system?: string;
	max_tokens: number;
	stream: true;
	temperature?: number;
	reasoning_effort?: "low" | "medium" | "high";
};

function readErrorMessage(body: JsonValue | undefined): string | undefined {
	if (!isJsonObject(body)) return undefined;
	const nested = body.error;
	if (isJsonObject(nested) && isJsonString(nested.message)) return nested.message;
	if (isJsonString(body.message)) return body.message;
	return undefined;
}

function readErrorStatusCode(body: JsonValue | undefined): number | undefined {
	if (!isJsonObject(body)) return undefined;
	const nested = body.error;
	if (isJsonObject(nested) && isJsonNumber(nested.statusCode)) return nested.statusCode;
	return undefined;
}

function textOf(content: string | (TextContent | { type: string })[]): string {
	if (isJsonString(content)) return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function buildMessages(context: Context): WireMessage[] {
	const messages: WireMessage[] = [];
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "developer") {
			// The gateway has no developer role; fold it into a user turn.
			messages.push({
				role: "user",
				content: [{ type: "text", text: textOf(message.content) }],
			});
		} else if (message.role === "assistant") {
			const parts: WireContentPart[] = [];
			for (const part of message.content) {
				if (part.type === "text") {
					parts.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					parts.push({
						type: "tool-call",
						toolCallId: part.id,
						toolName: part.name,
						input: part.arguments,
					});
				}
				// thinking / redactedThinking have no replay slot on the gateway; drop them.
			}
			if (parts.length > 0) messages.push({ role: "assistant", content: parts });
		} else if (message.role === "toolResult") {
			messages.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						output: {
							type: "text",
							value: message.content
								.filter((part): part is TextContent => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						},
						isError: message.isError,
					},
				],
			});
		}
	}
	return messages;
}

function buildBody(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	threadId: string,
) {
	const params: WireParams = {
		model: model.id,
		messages: buildMessages(context),
		max_tokens: Math.min(
			options?.maxTokens ?? DEFAULT_MAX_TOKENS,
			model.maxTokens ?? DEFAULT_MAX_TOKENS,
		),
		stream: true,
	};
	const system = context.systemPrompt?.join("\n\n");
	if (system) params.system = system;
	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	const effort = options?.reasoning;
	if (model.reasoning && (effort === "low" || effort === "medium" || effort === "high")) {
		params.reasoning_effort = effort;
	}
	// Wrapper shape verified live against POST /alpha/generate: the gateway rejects
	// null wrapper fields — memory/taste/skills are strings and config is an object.
	const apiEnv = process.env.COMMANDCODE_API_ENV;
	const environment: string =
		apiEnv === undefined ? "production" : apiEnv === "prod" ? "production" : apiEnv;
	return {
		config: {
			workingDir: process.cwd(),
			date: new Date().toISOString().slice(0, 10),
			environment,
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: [],
		},
		memory: "",
		taste: "",
		skills: "",
		permissionMode: "auto-accept",
		threadId,
		mode: "agent",
		params,
	};
}

function seedPartial(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API_ID,
		provider: PROVIDER_ID,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Vendor's callModelWithRetry backoff curve, clamped to [1s, 10s]. */
function backoffMs(attempt: number): number {
	return Math.min(10_000, Math.max(1_000, 100 * 2 ** attempt));
}

/**
 * Collapse every bearer source into one resolver. omp's agent loop passes an
 * ApiKeyResolver in `options.apiKey`; a pinned literal has nothing to rotate
 * to, so it resolves to itself; a direct caller (test, embedder) gets
 * AuthStorage's own a/b/c resolver. Undefined means no credential at all.
 */
function keyResolver(
	apiKey: ApiKey | undefined,
	auth: AuthStorage | undefined,
	modelId: string,
	sessionId: string | undefined,
): ApiKeyResolver | undefined {
	if (isApiKeyResolver(apiKey)) return apiKey;
	if (isJsonString(apiKey) && apiKey !== "") return () => apiKey;
	return auth?.resolver(PROVIDER_ID, { sessionId, modelId });
}

/** Sleep that resolves `false` early when the abort signal fires. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	if (signal?.aborted) {
		resolve(false);
		return promise;
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve(true);
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		resolve(false);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function isAbortError<T>(err: T): boolean {
	return err instanceof Error && err.name === "AbortError";
}

function readWireUsage(finishEvent: JsonObject, modelId: string): Usage | undefined {
	const totalUsage = finishEvent.totalUsage;
	if (!isJsonObject(totalUsage)) return undefined;
	const inputTokens = isJsonNumber(totalUsage.inputTokens) ? totalUsage.inputTokens : 0;
	const output = isJsonNumber(totalUsage.outputTokens) ? totalUsage.outputTokens : 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	const details = totalUsage.inputTokenDetails;
	if (isJsonObject(details)) {
		if (isJsonNumber(details.cacheReadTokens)) cacheRead = details.cacheReadTokens;
		if (isJsonNumber(details.cacheWriteTokens)) cacheWrite = details.cacheWriteTokens;
	}
	const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
	const rates = costForModel(modelId);
	const inputCost = (input * rates.input) / 1_000_000;
	const outputCost = (output * rates.output) / 1_000_000;
	const cacheReadCost = (cacheRead * rates.cacheRead) / 1_000_000;
	const cacheWriteCost = (cacheWrite * rates.cacheWrite) / 1_000_000;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: inputCost,
			output: outputCost,
			cacheRead: cacheReadCost,
			cacheWrite: cacheWriteCost,
			total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
		},
	};
}

type StreamOutcome =
	| "done"
	| "aborted"
	| "content-failed"
	| { status: number | undefined; body: JsonObject };

export function createCommandCodeStream(deps: {
	getAuthStorage(): AuthStorage | undefined;
	getSessionId(): string | undefined;
	getProjectSlug(): string;
	fetchImpl?: typeof fetch;
}): (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const streamStartTime = performance.now();
		void run(model, context, options, stream, streamStartTime).catch((err) => {
			// Last-resort guard: run() converts every known failure into a
			// terminal event, so reaching here means an unexpected throw.
			if (stream.done) return;
			const partial = seedPartial(model);
			const aborted = isAbortError(err);
			partial.stopReason = aborted ? "aborted" : "error";
			partial.errorMessage = err instanceof Error ? err.message : String(err);
			partial.duration = performance.now() - streamStartTime;
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
		});
		// SAFETY: the local stream implements the host event stream's public
		// surface member-for-member; the host consumes push/end/fail/result(),
		// iteration, and done at runtime, never the nominal #private marker.
		return stream as AssistantMessageEventStream;
	};

	async function run(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		stream: LocalAssistantMessageEventStream,
		startTime: number,
	): Promise<void> {
		const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
		const signal = options?.signal;
		const sessionId = deps.getSessionId();
		const threadId = sessionId ?? crypto.randomUUID();
		const partial = seedPartial(model);
		partial.timestamp = Date.now();
		stream.push({ type: "start", partial });

		interface StreamMetrics {
			firstTokenAt?: number;
		}
		const metrics: StreamMetrics = {};
		const stampMetrics = (): void => {
			partial.duration = performance.now() - startTime;
			if (metrics.firstTokenAt != null) {
				partial.ttft = metrics.firstTokenAt - startTime;
			}
		};

		const fail = (message: string, status?: number): void => {
			partial.stopReason = "error";
			partial.errorMessage = message;
			if (status !== undefined) partial.errorStatus = status;
			stampMetrics();
			stream.push({ type: "error", reason: "error", error: partial });
		};

		const failAborted = (): void => {
			partial.stopReason = "aborted";
			partial.errorMessage = "Command Code request aborted";
			stampMetrics();
			stream.push({ type: "error", reason: "aborted", error: partial });
		};

		const authStorage = deps.getAuthStorage();
		const resolver = keyResolver(options?.apiKey, authStorage, model.id, sessionId);
		let key = resolver === undefined ? undefined : await resolveApiKeyOnce(resolver, signal);
		if (key === undefined || resolver === undefined) {
			fail(NO_KEY_MESSAGE);
			return;
		}

		let rateLimitAttempt = 0;
		let upstreamRetries = 0;
		let quotaSwitches = 0;
		let authStep = 0;
		let otherRetried = false;
		/** Walk the remaining native a/b/c steps until the resolver yields a different bearer. */
		const nextAuthKey = async (
			error: JsonValue,
			previousKey: string,
		): Promise<string | undefined> => {
			while (authStep < AUTH_RETRY_STEPS.length) {
				const lastChance = AUTH_RETRY_STEPS[authStep] ?? true;
				authStep += 1;
				const next = await resolver({ lastChance, error, previousKey, signal });
				if (next !== undefined && next !== previousKey) return next;
			}
			return undefined;
		};

		for (;;) {
			if (signal?.aborted) {
				failAborted();
				return;
			}

			let response: Response;
			try {
				response = await fetchImpl(`${resolveBaseUrl()}/alpha/generate`, {
					method: "POST",
					headers: buildHeaders(key, {
						sessionId: sessionId ?? threadId,
						projectSlug: deps.getProjectSlug(),
					}),
					body: JSON.stringify(buildBody(model, context, options, threadId)),
					signal,
				});
			} catch (err) {
				if (isAbortError(err) || signal?.aborted) {
					failAborted();
					return;
				}
				if (upstreamRetries < MAX_UPSTREAM_RETRIES) {
					upstreamRetries += 1;
					if (!(await abortableSleep(backoffMs(upstreamRetries), signal))) {
						failAborted();
						return;
					}
					continue;
				}
				fail(err instanceof Error ? err.message : String(err));
				return;
			}

			let status: number | undefined;
			let body: JsonObject;
			if (!response.ok) {
				status = response.status;
				const text = await response.text().catch(() => "");
				let parsed: JsonValue;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = null;
				}
				body = isJsonObject(parsed) ? parsed : {};
			} else {
				const outcome = await consumeStream(
					response,
					partial,
					stream,
					model.id,
					metrics,
					stampMetrics,
				);
				if (outcome === "done") return;
				if (outcome === "aborted") {
					failAborted();
					return;
				}
				if (outcome === "content-failed") {
					// A content event is already on the wire; replaying would
					// duplicate it. The terminal error was pushed inside consumeStream.
					return;
				}
				status = outcome.status;
				body = outcome.body;
				const retryable = status === undefined || status === 429 || status >= 500;
				if (retryable && upstreamRetries < MAX_UPSTREAM_RETRIES) {
					upstreamRetries += 1;
					if (!(await abortableSleep(backoffMs(upstreamRetries), signal))) {
						failAborted();
						return;
					}
					continue;
				}
			}

			// Failure handling (plan step 9). Nothing beyond `start` has been
			// emitted on every path that reaches here, so retrying is safe.
			const verdict = classifyFailure(status, body);

			if (verdict === "quota" && authStorage) {
				const resetMs = resetAtMs(body);
				const mark = await authStorage.markUsageLimitReached(PROVIDER_ID, sessionId, {
					retryAfterMs: resetMs !== undefined ? resetMs - Date.now() : undefined,
					modelId: model.id,
					apiKey: key,
					signal,
				});
				quotaSwitches += 1;
				if (mark.switched && quotaSwitches < MAX_KEY_ATTEMPTS) {
					// markUsageLimitReached already advanced the session-sticky pointer,
					// so an initial resolve returns the sibling. Asking the resolver to
					// rotate (lastChance) here would rotate twice and skip a key.
					const next = await resolveApiKeyOnce(resolver, signal);
					if (next !== undefined && next !== key) {
						key = next;
						continue;
					}
				}
				let poolSize = 1;
				try {
					poolSize = Math.max(1, authStorage.listStoredCredentials(PROVIDER_ID).length);
				} catch {
					poolSize = 1;
				}
				const resetIso =
					mark.retryAtMs !== undefined ? new Date(mark.retryAtMs).toISOString() : "unknown";
				fail(
					`Command Code quota exhausted on all ${poolSize} key(s). Earliest reset: ${resetIso}. Run /login to add another key.`,
				);
				return;
			}

			if (verdict === "auth") {
				const next = await nextAuthKey(body, key);
				if (next !== undefined) {
					key = next;
					continue;
				}
				fail(
					`Command Code rejected the API key ending in …${key.slice(-4)}. Run /login to replace it.`,
					status,
				);
				return;
			}

			if (verdict === "rate-limit") {
				// Transient server throttling: back off, never rotate the key.
				if (rateLimitAttempt < MAX_RATE_LIMIT_ATTEMPTS) {
					rateLimitAttempt += 1;
					if (!(await abortableSleep(backoffMs(rateLimitAttempt), signal))) {
						failAborted();
						return;
					}
					continue;
				}
				fail(readErrorMessage(body) ?? "Command Code rate limit persisted across retries", status);
				return;
			}

			// verdict === "other"
			const retryable = status !== undefined && (status === 429 || status >= 500);
			if (retryable && !otherRetried && upstreamRetries === 0) {
				otherRetried = true;
				if (!(await abortableSleep(backoffMs(1), signal))) {
					failAborted();
					return;
				}
				continue;
			}
			fail(
				readErrorMessage(body) ??
					`Command Code request failed${status !== undefined ? ` (HTTP ${status})` : ""}`,
				status,
			);
			return;
		}
	}

	async function consumeStream(
		response: Response,
		partial: AssistantMessage,
		stream: LocalAssistantMessageEventStream,
		modelId: string,
		metrics: { firstTokenAt?: number },
		stampMetrics: () => void,
	): Promise<StreamOutcome> {
		if (!response.body) return { status: response.status, body: {} };
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let contentIndex = 0;
		let openBlock: "text" | "thinking" | undefined;
		let sawToolCall = false;

		const fail = (message: string, status?: number): void => {
			partial.stopReason = "error";
			partial.errorMessage = message;
			if (status !== undefined) partial.errorStatus = status;
			stampMetrics();
			stream.push({ type: "error", reason: "error", error: partial });
		};

		const closeOpenBlock = (): void => {
			if (openBlock === "text") {
				const part = partial.content[contentIndex];
				stream.push({
					type: "text_end",
					contentIndex,
					content: part?.type === "text" ? part.text : "",
					partial,
				});
				contentIndex += 1;
			} else if (openBlock === "thinking") {
				const part = partial.content[contentIndex];
				stream.push({
					type: "thinking_end",
					contentIndex,
					content: part?.type === "thinking" ? part.thinking : "",
					partial,
				});
				contentIndex += 1;
			}
			// toolcall blocks close on their own toolcall_end event.
			openBlock = undefined;
		};

		for (;;) {
			const result = await reader.read().catch((err) => {
				if (isAbortError(err)) return null;
				throw err;
			});
			if (result === null) return "aborted";
			if (result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.length === 0) continue;

				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					// Guards against a trailing partial chunk; not fatal.
					continue;
				}
				if (!isObjectLike(event) || !isJsonString(event.type)) continue;

				// SAFETY: the guard above narrowed `event` to a non-null object
				// whose `type` field is a string; JSON.parse can only produce
				// JSON values, so the remaining fields are JsonObject members.
				const ev: JsonObject = event;

				switch (event.type) {
					case "text-delta": {
						if (!isJsonString(ev.text)) break;
						metrics.firstTokenAt ??= performance.now();
						if (openBlock !== "text") {
							closeOpenBlock();
							partial.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex, partial });
							openBlock = "text";
						}
						const part = partial.content[contentIndex];
						if (part?.type === "text") part.text += ev.text;
						stream.push({ type: "text_delta", contentIndex, delta: ev.text, partial });
						break;
					}
					case "reasoning-start": {
						if (openBlock !== "thinking") {
							closeOpenBlock();
							partial.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex, partial });
							openBlock = "thinking";
						}
						break;
					}
					case "reasoning-delta": {
						if (!isJsonString(ev.text)) break;
						metrics.firstTokenAt ??= performance.now();
						if (openBlock !== "thinking") {
							closeOpenBlock();
							partial.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex, partial });
							openBlock = "thinking";
						}
						const part = partial.content[contentIndex];
						if (part?.type === "thinking") part.thinking += ev.text;
						stream.push({ type: "thinking_delta", contentIndex, delta: ev.text, partial });
						break;
					}
					case "reasoning-end": {
						if (openBlock === "thinking") closeOpenBlock();
						break;
					}
					case "tool-call": {
						if (
							!isJsonString(ev.toolCallId) ||
							!isJsonString(ev.toolName) ||
							ev.input === undefined
						) {
							break;
						}
						closeOpenBlock();
						sawToolCall = true;
						const input: Record<string, unknown> = isJsonObject(ev.input) ? ev.input : {};
						const toolCall: ToolCall = {
							type: "toolCall",
							id: ev.toolCallId,
							name: ev.toolName,
							arguments: input,
						};
						stream.push({ type: "toolcall_start", contentIndex, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(input),
							partial,
						});
						partial.content.push(toolCall);
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
						contentIndex += 1;
						break;
					}
					case "tool-result": {
						// Provider-executed tool results are ignored; omp executes tools itself.
						break;
					}
					case "finish": {
						closeOpenBlock();
						const usage = readWireUsage(ev, modelId);
						if (usage) partial.usage = usage;
						const finishReason = isJsonString(ev.finishReason) ? ev.finishReason : "";
						if (sawToolCall || finishReason === "tool_calls") {
							partial.stopReason = "toolUse";
						} else if (finishReason === "max_tokens" || finishReason === "length") {
							partial.stopReason = "length";
						} else {
							partial.stopReason = "stop";
						}
						stampMetrics();
						stream.push({ type: "done", reason: partial.stopReason, message: partial });
						return "done";
					}
					case "error": {
						// Mid-stream failure: error.statusCode is the status, the whole
						// line is the classification body.
						const status = readErrorStatusCode(ev);
						if (openBlock !== undefined || contentIndex > 0) {
							closeOpenBlock();
							fail(readErrorMessage(ev) ?? "Command Code stream failed", status);
							return "content-failed";
						}
						return { status, body: ev };
					}
					default:
						break;
				}
			}
		}

		// Stream ended without a finish event.
		if (openBlock !== undefined || contentIndex > 0) closeOpenBlock();
		fail(MISSING_FINISH_MESSAGE);
		return "content-failed";
	}
}
