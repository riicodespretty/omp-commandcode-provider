import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream as HostEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/**
 * Native replacement for the host's event-stream helpers the provider
 * consumes: `EventStream`, `AssistantMessageEventStream`, and
 * `createAssistantMessageEventStream`, plus the auth-retry helpers
 * `isApiKeyResolver`, `resolveApiKeyOnce`, and `AUTH_RETRY_STEPS`.
 *
 * `EventStream` mirrors the host's public contract: `push` delivers events to
 * waiting consumers or queues them, `end`/`fail` settle the terminal
 * `result()` promise, and async iteration drains queued events then waits for
 * more. `AssistantMessageEventStream` completes on the terminal `done`/`error`
 * event. `createAssistantMessageEventStream` is the factory.
 */

/** A terminal event. Its result is the final `AssistantMessage`. */
function isTerminalEvent(event: AssistantMessageEvent): boolean {
	return event.type === "done" || event.type === "error";
}

/** The final message carried by a terminal event. */
function eventResult(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done" || event.type === "error") {
		return event.type === "done" ? event.message : event.error;
	}
	return event.partial;
}

/** A promise paired with its resolvers. */
interface PendingResolution<T> {
	resolve: (value: IteratorResult<T>) => void;
	reject: (err: Error) => void;
}

const pendingLocalWork = new WeakMap<object, number>();

/** An async queue of stream events that settles on a final result. */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	queue: T[] = [];
	waiting: PendingResolution<T>[] = [];
	done = false;
	resultSettled = false;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: Error) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();
		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
	}

	/** Deliver one event: complete settles the final result, then hands it to a waiting consumer or queues it. */
	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) {
			this.done = true;
			this.resultSettled = true;
			this.resolveFinalResult(this.extractResult(event));
		}
		this.deliver(event);
	}

	/** Hand one event to a waiting consumer or queue it. */
	deliver(event: T): void {
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/** Settle the stream with an optional final result; without one, settle with an error. */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.resultSettled) {
			this.resultSettled = true;
			this.rejectFinalResult(new Error("Stream ended without a final result"));
		}
		this.endWaiting();
	}

	/** Release all waiting consumers with a done iteration result. */
	endWaiting(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter) waiter.resolve({ value: undefined, done: true });
		}
	}

	/** Fail the stream: settle the final result with the error and reject waiting consumers. */
	fail(err: Error): void {
		if (this.done) return;
		this.done = true;
		this.resultSettled = true;
		this.rejectFinalResult(err);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter) waiter.reject(err);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const queued = this.queue.shift();
			if (queued !== undefined) {
				yield queued;
				continue;
			}
			if (this.done) return;
			const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
				this.waiting.push({ resolve, reject });
			});
			if (result.done) return;
			yield result.value;
		}
	}

	/** The terminal result promise: resolves with the final message, rejects with the stream error. */
	result(): Promise<R> {
		return this.finalResultPromise;
	}

	/** True while local work tracked via trackLocalWork is pending. */
	get hasPendingLocalWork(): boolean {
		return (pendingLocalWork.get(this) ?? 0) > 0;
	}

	/** Track a local-work promise so idle watchdogs do not treat event silence as a provider stall. */
	async trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork> {
		pendingLocalWork.set(this, (pendingLocalWork.get(this) ?? 0) + 1);
		try {
			return await work;
		} finally {
			pendingLocalWork.set(this, (pendingLocalWork.get(this) ?? 0) - 1);
		}
	}
}

/** An event stream over assistant message events, completing on `done`/`error`. */
export class AssistantMessageEventStream extends EventStream<
	AssistantMessageEvent,
	AssistantMessage
> {
	constructor() {
		super(isTerminalEvent, eventResult);
	}
}

/** Create an assistant-message event stream for legacy extension providers. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}

// The host's event stream carries a nominal `#private` member that blocks
// direct structural assignment; the runtime surface it actually consumes is
// the public members below. This check keeps our public surface in sync with
// the host's declared one at compile time.
type HostPublicSurface = Omit<HostEventStream, never>;
type LocalPublicSurface = Omit<EventStream<AssistantMessageEvent, AssistantMessage>, never>;
type _ParityCheck = keyof HostPublicSurface extends keyof LocalPublicSurface ? true : never;
true satisfies _ParityCheck;
