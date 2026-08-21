/**
 * Command Code provider — endpoints, headers, and failure classification.
 *
 * Reverse-engineered from `command-code@1.14.0`. The gateway at
 * `https://api.commandcode.ai` speaks a bespoke protocol: `POST /alpha/generate`
 * (streaming ndjson) and `GET /alpha/whoami` (key validation). There is no
 * `/models` discovery endpoint and no OpenAI/Anthropic wire compatibility.
 */

import { isFiniteJsonNumber, isJsonObject, isJsonString, type JsonObject } from "./guards";

export const PROVIDER_ID = "commandcode";
export const API_ID = "commandcode-generate";
export const STUDIO_AUTH_URL = "https://commandcode.ai/studio/auth/cli";
/** Impersonates the CLI build we reversed. */
export const CLI_VERSION_HEADER = "1.14.0";
export const DEFAULT_MAX_TOKENS = 64_000;
export const CALLBACK_PORTS = [5959, 5960, 5961, 5962, 5963, 5964, 5965, 5966, 5967, 5968] as const;

type Env = Readonly<Record<string, string | undefined>>;

const ENV_URLS = {
	local: "http://localhost:9090",
	staging: "https://staging-api.commandcode.ai",
	prod: "https://api.commandcode.ai",
} as const satisfies Record<"local" | "staging" | "prod", string>;

/**
 * Resolve the Command Code base URL.
 *
 * `COMMANDCODE_SANDBOX === "true"` with a set `COMMANDCODE_API_URL` wins; else
 * `COMMANDCODE_API_ENV` is mapped through {local, staging, prod}, defaulting to
 * prod for unset or unknown values.
 */
export function resolveBaseUrl(env: Env = process.env): string {
	if (env.COMMANDCODE_SANDBOX === "true" && env.COMMANDCODE_API_URL) {
		return env.COMMANDCODE_API_URL;
	}
	const apiEnv = env.COMMANDCODE_API_ENV;
	const key: "local" | "staging" | "prod" =
		apiEnv === "local" || apiEnv === "staging" || apiEnv === "prod" ? apiEnv : "prod";
	return ENV_URLS[key];
}

/**
 * Strip bracketed-paste markers (`[200~` / `[201~`) and ASCII control
 * characters (code ≤ 31 or 127), then trim. Mirrors the CLI's
 * `sanitizeCommandApiKeyInput`.
 */
export function sanitizeApiKey(raw: string): string {
	const stripped = raw.replace(/\[20[01]~/g, "");
	const filtered = Array.from(stripped)
		.filter((ch) => {
			const code = ch.codePointAt(0);
			return code !== undefined && code > 31 && code !== 127;
		})
		.join("");
	return filtered.trim();
}

/**
 * Build the exact header set the CLI sends on `/alpha/generate`.
 * `x-cli-environment` is `"production"` for prod, otherwise the env name.
 */
export function buildHeaders(apiKey: string, o: { sessionId: string; projectSlug: string }) {
	const envName = process.env.COMMANDCODE_API_ENV ?? "prod";
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"User-Agent": "cli",
		"x-command-code-version": CLI_VERSION_HEADER,
		"x-cli-environment": envName === "prod" ? "production" : envName,
		"x-session-id": o.sessionId,
		"x-project-slug": o.projectSlug,
		"x-taste-learning": "false",
		"x-co-flag": "false",
	} satisfies Record<string, string>;
}

export type Verdict = "quota" | "auth" | "rate-limit" | "other";

interface ParsedError {
	message: string;
	code: string;
	type: string;
	rateLimitWindow: string | undefined;
	rateLimitReset: number | undefined;
}

/**
 * Extract the Anthropic-style error fields from a response body.
 * Reads `body.error.{message,code,type,rateLimit}` with top-level fallbacks.
 * A non-object body is treated as an empty object.
 */
function parseErrorBody(body: JsonObject): ParsedError {
	const err = isJsonObject(body.error) ? body.error : null;
	const message =
		(isJsonString(err?.message) ? err.message : undefined) ??
		(isJsonString(body.message) ? body.message : undefined) ??
		"";
	const code =
		(isJsonString(err?.code) ? err.code : undefined) ??
		(isJsonString(body.code) ? body.code : undefined) ??
		"";
	const type =
		(isJsonString(err?.type) ? err.type : undefined) ??
		(isJsonString(body.type) ? body.type : undefined) ??
		"";
	const rateLimit = isJsonObject(err?.rateLimit) ? err.rateLimit : null;
	const resetRaw = rateLimit?.reset;
	const rateLimitReset = isFiniteJsonNumber(resetRaw) ? resetRaw : undefined;
	const windowRaw = rateLimit?.window;
	const rateLimitWindow = isJsonString(windowRaw) ? windowRaw : undefined;
	return {
		message,
		code,
		type,
		rateLimitWindow,
		rateLimitReset,
	};
}

/**
 * Classify a failure so the stream layer knows whether to rotate keys.
 *
 * Credit exhaustion is a `400` plus a message substring — omp's built-in
 * classifier keys usage limits on 429/402 and would miss it, so the plugin
 * classifies itself. `status === undefined` covers a mid-stream `error` line
 * with no `statusCode`; classification then relies on message and code alone.
 */
export function classifyFailure(status: number | undefined, body: JsonObject): Verdict {
	const { message, code, type, rateLimitWindow } = parseErrorBody(body);
	const lowerMsg = message.toLowerCase();

	// quota — a plan window or the credits are exhausted: block the key, rotate.
	// Mirrors the vendor's parseWindowLimitError: code RATE_LIMITED or status 429 is
	// only a window limit when the window label resolves (rateLimit.window or the
	// "usage limit for your plan" message); otherwise it is a transient rate limit.
	if (
		(status === 400 && lowerMsg.includes("insufficient credits")) ||
		message.includes("PREMIUM_CREDITS_EXHAUSTED:") ||
		((code === "RATE_LIMITED" || status === 429) &&
			(rateLimitWindow === "fiveHour" ||
				rateLimitWindow === "weekly" ||
				/usage limit for your plan/i.test(message)))
	) {
		return "quota";
	}

	// auth — the key itself is bad.
	if (
		status === 401 ||
		/unauthor|invalid api key|missing api key/i.test(message) ||
		message.includes("Invalid 'Authorization' header")
	) {
		return "auth";
	}

	// rate-limit — back off, do NOT rotate.
	if (status === 429 || code === "RATE_LIMITED" || type === "rate_limit_error") {
		return "rate-limit";
	}

	return "other";
}

/**
 * Resolve the earliest reset time (epoch ms) for a quota/rate-limit failure.
 * Primary: `error.rateLimit.reset` (epoch seconds) × 1000.
 * Fallback: an ISO timestamp captured by `/resets at (…Z)/i` on the message.
 */
export function resetAtMs(body: JsonObject): number | undefined {
	const { rateLimitReset, message } = parseErrorBody(body);
	if (rateLimitReset !== undefined) {
		return rateLimitReset * 1000;
	}
	const match = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message);
	const iso = match?.[1];
	if (iso !== undefined) {
		const ms = Date.parse(iso);
		if (!Number.isNaN(ms)) {
			return ms;
		}
	}
	return undefined;
}
