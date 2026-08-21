/**
 * Dynamic Command Code model catalog discovery.
 *
 * Fetches the live model catalog from Command Code's keyless provider endpoint
 * and maps it into ProviderModelConfig entries using the local capability snapshot.
 */

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

import { DEFAULT_MAX_TOKENS, resolveBaseUrl } from "./api";
import { isFiniteJsonNumber, isJsonObject, isJsonString, type JsonValue } from "./guards";
import { capabilitiesForModel } from "./models";
import { costForModel } from "./pricing";

export const MODELS_PATH = "/provider/v1/models";
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveModelsUrl(env: Env = process.env): string {
	const customUrl = env.COMMANDCODE_MODELS_URL;
	if (customUrl && customUrl.trim().length > 0) {
		return customUrl.trim();
	}
	return `${resolveBaseUrl(env)}${MODELS_PATH}`;
}

export function resolveModelsTimeoutMs(env: Env = process.env): number {
	const raw = env.COMMANDCODE_MODELS_TIMEOUT_MS;
	if (raw) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_MODELS_TIMEOUT_MS;
}

export function modelsFromApiResponse(value: JsonValue | undefined): ProviderModelConfig[] {
	if (!isJsonObject(value)) {
		throw new Error("Expected models response to be an object");
	}

	const record = value;
	if (record.object !== "list") {
		throw new Error("Expected models response object to be 'list'");
	}

	if (!Array.isArray(record.data)) {
		throw new Error("Expected models response data to be an array");
	}

	if (record.data.length === 0) {
		throw new Error("Expected models response data array to not be empty");
	}

	const models: ProviderModelConfig[] = [];
	for (let i = 0; i < record.data.length; i++) {
		const item = record.data[i];
		if (!isJsonObject(item)) {
			throw new Error(`Expected model entry at index ${i} to be an object`);
		}

		const entry = item;
		if (!isJsonString(entry.id) || entry.id.trim().length === 0) {
			throw new Error(`Expected model entry at index ${i} to have a non-empty string 'id'`);
		}

		if (!isJsonString(entry.name) || entry.name.trim().length === 0) {
			throw new Error(`Expected model entry at index ${i} to have a non-empty string 'name'`);
		}

		if (!isFiniteJsonNumber(entry.context_length) || entry.context_length <= 0) {
			throw new Error(
				`Expected model entry at index ${i} to have a positive finite 'context_length'`,
			);
		}

		const capabilities = capabilitiesForModel(entry.id);
		models.push({
			id: entry.id,
			name: entry.name,
			reasoning: capabilities.reasoning,
			input: capabilities.input,
			cost: costForModel(entry.id),
			contextWindow: entry.context_length,
			maxTokens: Math.min(entry.context_length, DEFAULT_MAX_TOKENS),
		});
	}

	return models;
}

export interface FetchCommandCodeModelsOptions {
	url?: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function fetchCommandCodeModels(
	options: FetchCommandCodeModelsOptions = {},
): Promise<ProviderModelConfig[]> {
	const url = options.url ?? resolveModelsUrl();
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? resolveModelsTimeoutMs();
	const externalSignal = options.signal;

	if (externalSignal?.aborted) {
		throw externalSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
	}

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`Command Code model discovery timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onExternalAbort = () => {
		controller.abort(
			externalSignal?.reason ?? new DOMException("The operation was aborted", "AbortError"),
		);
	};

	if (externalSignal) {
		externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}

	try {
		const baseHeaders = { accept: "application/json", "User-Agent": "cli" };
		const headers = options.apiKey
			? { ...baseHeaders, Authorization: `Bearer ${options.apiKey}` }
			: baseHeaders;
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		if (!response.ok) {
			const statusText = response.statusText ? ` ${response.statusText}` : "";
			throw new Error(`Failed to fetch Command Code models: ${response.status}${statusText}`);
		}

		const body = await response.json();
		return modelsFromApiResponse(body);
	} catch (error) {
		if (timedOut) {
			throw new Error(`Command Code model discovery timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		if (externalSignal) {
			externalSignal.removeEventListener("abort", onExternalAbort);
		}
	}
}
