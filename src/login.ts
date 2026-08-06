import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CALLBACK_PORTS, resolveBaseUrl, STUDIO_AUTH_URL, sanitizeApiKey } from "./api";

/**
 * Run the Command Code login flow.
 *
 * Spins up a loopback callback server (first free port in {@link CALLBACK_PORTS})
 * and races it against a manual paste prompt, so headless / SSH users can still
 * complete login by pasting a `user_…` key. The returned string is a validated
 * API key; omp persists it. Structurally compatible with `OAuthLoginCallbacks`.
 */
export async function loginWithCommandCode(cb: {
	onAuth(info: { url: string; instructions?: string }): void;
	onPrompt(p: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	signal?: AbortSignal;
}): Promise<string> {
	const state = randomUUID();
	const signal = cb.signal;

	// Bind the first available callback port; fall back to paste-only.
	let server: Server | undefined;
	let port: number | undefined;
	for (const candidate of CALLBACK_PORTS) {
		const s = createServer();
		const ok = await new Promise<boolean>((resolve) => {
			s.once("error", () => resolve(false));
			s.listen(candidate, "127.0.0.1", () => resolve(true));
		});
		if (ok) {
			server = s;
			port = candidate;
			break;
		}
		s.close();
	}

	const callbackUrl =
		port !== undefined
			? `${STUDIO_AUTH_URL}?callback=${encodeURIComponent(`http://localhost:${port}/callback`)}&state=${state}`
			: STUDIO_AUTH_URL;

	cb.onAuth({
		url: callbackUrl,
		instructions: "Approve the CLI in your browser, or paste a Provider API key here.",
	});

	// Callback path — resolves only on a state-matching POST /callback.
	let resolveKey: ((key: string) => void) | undefined;
	const callbackKey = new Promise<string>((resolve) => {
		resolveKey = resolve;
	});

	if (server !== undefined) {
		const onMatch = (key: string): void => resolveKey?.(key);
		server.on("request", (req, res) => handleCallback(req, res, state, onMatch));
	}

	// Paste path is always available, even when no port could be bound.
	const promptPromise = cb.onPrompt({
		message: "Paste your Command Code API key",
		placeholder: "user_…",
		allowEmpty: false,
	});

	// Abort path.
	const abortPromise: Promise<never> = signal
		? new Promise<never>((_, reject) => {
				const onAbort = (): void => reject(new Error("Command Code login cancelled"));
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			})
		: new Promise<never>(() => {});

	const sources: Promise<string>[] = [promptPromise, abortPromise];
	if (server !== undefined) sources.push(callbackKey);

	try {
		const raw = await Promise.race(sources);
		const key = sanitizeApiKey(raw);
		if (key === "") throw new Error("Command Code API key is empty");
		await validateApiKey(key);
		return key;
	} finally {
		if (server !== undefined) {
			server.removeAllListeners();
			await closeServer(server);
		}
	}
}

/**
 * Validate a Command Code API key against `GET /alpha/whoami`.
 * Throws on any non-200 or `success !== true` response. `keyName` is not
 * surfaced by whoami, so it is always `undefined`.
 */
export async function validateApiKey(
	key: string,
	baseUrl: string = resolveBaseUrl(),
): Promise<{ userName?: string; keyName?: string }> {
	const res = await fetch(`${baseUrl}/alpha/whoami`, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
	});
	if (res.status !== 200) {
		throw new Error(`Command Code rejected that API key (HTTP ${res.status})`);
	}
	const body = (await res.json()) as { success?: unknown; user?: { userName?: string } };
	if (body.success !== true) {
		throw new Error(`Command Code rejected that API key (HTTP ${res.status})`);
	}
	return { userName: body.user?.userName, keyName: undefined };
}

function handleCallback(
	req: IncomingMessage,
	res: ServerResponse,
	state: string,
	onMatch: (key: string) => void,
): void {
	if (req.method !== "POST" || req.url !== "/callback") {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
		return;
	}

	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("error", () => {
		if (!res.headersSent) res.writeHead(400, { "Content-Type": "text/plain" });
		res.end();
	});
	req.on("end", () => {
		let payload: { apiKey?: string; state?: string };
		try {
			payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				apiKey?: string;
				state?: string;
			};
		} catch {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Invalid JSON");
			return;
		}

		if (payload.state !== state) {
			// Mismatched state — reject and keep waiting for the real callback.
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("State mismatch");
			return;
		}

		const key = typeof payload.apiKey === "string" ? payload.apiKey : "";
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(
			"<!doctype html><html><body><h2>Command Code login successful</h2>" +
				"<p>You may close this tab and return to the terminal.</p></body></html>",
		);
		if (key !== "") onMatch(key);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}
