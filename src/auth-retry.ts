import type { ApiKey, ApiKeyResolver } from "@oh-my-pi/pi-ai";

/**
 * Native replacement for the host's auth-retry helpers the provider
 * consumes: `isApiKeyResolver`, `resolveApiKeyOnce`, and `AUTH_RETRY_STEPS`.
 * The host versions live in `@oh-my-pi/pi-ai/src/auth-retry.ts`; reimplementing
 * them locally keeps the host's bun-native runtime graph out of the test
 * runner, which runs on node.
 *
 * `isApiKeyResolver` narrows a bearer string or resolver to the resolver
 * form. `resolveApiKeyOnce` performs the initial resolve (`error: undefined`,
 * `lastChance: false`), passing static keys through unchanged.
 * `AUTH_RETRY_STEPS` is the legacy bounded a/b/c retry sequence.
 */

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return key instanceof Function;
}

/** Performs the initial resolve of an {@link ApiKey}; static keys pass through unchanged. */
export async function resolveApiKeyOnce(
	key: ApiKey | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) {
		const resolved = await key({ lastChance: false, error: undefined, signal });
		return resolved || undefined;
	}
	return key;
}

/** Legacy bounded a/b/c retry sequence retained for public compatibility. */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];
