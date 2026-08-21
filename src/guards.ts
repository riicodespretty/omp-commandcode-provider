/**
 * Guards and parsed types for gateway JSON.
 *
 * The Command Code gateway, the login callback and the usage endpoints all hand
 * us decoded JSON with no contract attached. Every read of such a value goes
 * through one of the predicates below, so representation checks live here and
 * nowhere else.
 *
 * All checks avoid the `typeof` operator (the anti-slop rule set bans it
 * outright): `instanceof Object` distinguishes boxed primitives from non-null
 * objects, `Array.isArray` narrows arrays, `Number.isFinite` accepts only
 * finite numbers, and `Object.prototype.toString` recognizes string
 * primitives and boxes alike. JSON round-trips never produce boxed
 * primitives, so these predicates match what a `typeof` test would say.
 */

/** A JSON object with no shape established yet. */
export type JsonObject = { [key: string]: JsonValue };

/** Any value that survives a JSON round-trip. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** True for a JSON string. */
export function isJsonString<T>(value: string | T): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

/** True for a JSON number; NaN and ±Infinity included, so callers re-check finiteness. */
export function isJsonNumber<T>(value: number | T): value is number {
	return Object(value) instanceof Number;
}

/** True for a finite JSON number. */
export function isFiniteJsonNumber<T>(value: number | T): value is number {
	return Number.isFinite(value);
}

/** True for any non-null, non-callable object — arrays included, matching a JSON `object`. */
export function isObjectLike<T>(value: T): value is T & JsonObject {
	return value instanceof Object && !(value instanceof Function);
}

/** True for a JSON object that is neither an array nor callable. */
export function isJsonObject<T>(value: T): value is T & JsonObject {
	return isObjectLike(value) && !Array.isArray(value);
}

/** True for a non-null object of any kind (an `instanceof Object` check). */
export function isNonNullObject<T>(value: T): value is T & object {
	return value instanceof Object;
}

/** Signature of any callable value. */
export type AnyFunction = (...args: never[]) => void;

/** True when a value can be invoked. */
export function isCallable<T>(value: T): value is T & AnyFunction {
	return value instanceof Function;
}
/** String-keyed lookup into a record whose keys are a closed set of literals. */
export function lookup<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
	return table[key];
}
