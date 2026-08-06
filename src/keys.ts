import type { AuthStorage } from "@oh-my-pi/pi-ai";

import { PROVIDER_ID } from "./api";

/**
 * Command Code stores a pool of `user_` API keys in omp's credential store.
 * `AuthStorage.set` replaces a provider's whole entry, so appending is an
 * explicit read-modify-write.
 */

/** All stored Command Code API keys, in stable storage order. */
export function readPool(auth: AuthStorage): { id: number; key: string }[] {
	const out: { id: number; key: string }[] = [];
	for (const row of auth.listStoredCredentials(PROVIDER_ID)) {
		if (row.credential.type === "api_key") {
			out.push({ id: row.id, key: row.credential.key });
		}
	}
	return out;
}

/**
 * Append a key to the pool. Rejects an exact duplicate. Returns the new pool
 * size (1-based position of the appended key).
 */
export async function appendKey(auth: AuthStorage, key: string): Promise<number> {
	const existing = readPool(auth);
	if (existing.some((e) => e.key === key)) {
		throw new Error("That Command Code API key is already stored");
	}
	const entry = [
		...existing.map((e) => ({ type: "api_key" as const, key: e.key, source: "login" as const })),
		{ type: "api_key" as const, key, source: "login" as const },
	];
	await auth.set(PROVIDER_ID, entry);
	return existing.length + 1;
}

/** Remove the key at 1-based `position`. Returns false when out of range. */
export async function removeKeyAt(auth: AuthStorage, position: number): Promise<boolean> {
	const pool = readPool(auth);
	const row = pool[position - 1];
	if (!row) return false;
	return auth.removeCredential(PROVIDER_ID, row.id);
}
