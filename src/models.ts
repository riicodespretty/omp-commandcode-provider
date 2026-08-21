import { lookup } from "./guards";

export interface ModelCapabilities {
	reasoning: boolean;
	vision: boolean;
}

/** Reasoning and image support, which the discovery endpoint does not publish. */
export const MODEL_CAPABILITIES = {
	"MiniMaxAI/MiniMax-M2.5": { reasoning: false, vision: false },
	"MiniMaxAI/MiniMax-M2.7": { reasoning: false, vision: false },
	"MiniMaxAI/MiniMax-M3": { reasoning: true, vision: true },
	"Qwen/Qwen3.6-Max-Preview": { reasoning: true, vision: false },
	"Qwen/Qwen3.6-Plus": { reasoning: true, vision: true },
	"Qwen/Qwen3.7-Flash": { reasoning: true, vision: true },
	"Qwen/Qwen3.7-Max": { reasoning: true, vision: false },
	"Qwen/Qwen3.7-Plus": { reasoning: true, vision: true },
	"Qwen/Qwen3.8-27B": { reasoning: true, vision: true },
	"Qwen/Qwen3.8-Max": { reasoning: true, vision: true },
	"claude-fable-5": { reasoning: true, vision: true },
	"claude-haiku-4-5-20251001": { reasoning: false, vision: true },
	"claude-opus-4-7": { reasoning: true, vision: true },
	"claude-opus-4-8": { reasoning: true, vision: true },
	"claude-opus-5": { reasoning: true, vision: true },
	"claude-sonnet-4-6": { reasoning: true, vision: true },
	"claude-sonnet-5": { reasoning: true, vision: true },
	"deepseek/deepseek-v4-flash": { reasoning: true, vision: false },
	"deepseek/deepseek-v4-pro": { reasoning: true, vision: false },
	"google/gemini-3.1-flash-lite": { reasoning: true, vision: true },
	"google/gemini-3.5-flash": { reasoning: true, vision: true },
	"google/gemini-3.5-flash-lite": { reasoning: true, vision: true },
	"google/gemini-3.6-flash": { reasoning: true, vision: true },
	"google/gemini-3.7-flash": { reasoning: true, vision: true },
	"gpt-5.3-codex": { reasoning: true, vision: true },
	"gpt-5.4": { reasoning: true, vision: true },
	"gpt-5.4-mini": { reasoning: true, vision: true },
	"gpt-5.5": { reasoning: true, vision: true },
	"gpt-5.6-luna": { reasoning: true, vision: true },
	"gpt-5.6-sol": { reasoning: true, vision: true },
	"gpt-5.6-terra": { reasoning: true, vision: true },
	"meta/muse-spark-1.1": { reasoning: true, vision: true },
	"meta/muse-spark-1.2": { reasoning: true, vision: true },
	"meta/muse-spark-1.2-contributor": { reasoning: true, vision: true },
	"moonshotai/Kimi-K2.5": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.6": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.7-Code": { reasoning: true, vision: true },
	"moonshotai/Kimi-K2.7-Code-Highspeed": { reasoning: true, vision: true },
	"moonshotai/Kimi-K3": { reasoning: true, vision: true },
	"nvidia/nemotron-3-ultra-550b-a55b": { reasoning: true, vision: false },
	"poolside/laguna-s-2.1-free": { reasoning: true, vision: false },
	"sakana/fugu-ultra": { reasoning: true, vision: true },
	"stepfun/Step-3.5-Flash": { reasoning: true, vision: false },
	"stepfun/Step-3.7-Flash": { reasoning: true, vision: true },
	"tencent/hy3-paid": { reasoning: true, vision: false },
	"thinkingmachines/inkling": { reasoning: true, vision: true },
	"thinkingmachines/inkling-small": { reasoning: true, vision: true },
	"xai/grok-4.5": { reasoning: true, vision: true },
	"xai/grok-4.6": { reasoning: true, vision: false },
	"xiaomi/mimo-v2.5": { reasoning: false, vision: true },
	"xiaomi/mimo-v2.5-pro": { reasoning: false, vision: false },
	"zai-org/GLM-5": { reasoning: false, vision: false },
	"zai-org/GLM-5.1": { reasoning: false, vision: false },
	"zai-org/GLM-5.2": { reasoning: true, vision: false },
	"zai-org/GLM-5.2-Fast": { reasoning: false, vision: false },
	"zai-org/GLM-5.3": { reasoning: true, vision: false },
} satisfies Readonly<Record<string, ModelCapabilities>>;

const TEXT_ONLY: ("text" | "image")[] = ["text"];
const TEXT_IMAGE: ("text" | "image")[] = ["text", "image"];

/**
 * Capabilities for a discovered model id. An id the snapshot does not carry
 * claims nothing: text-only and non-reasoning.
 */
export interface ModelDiscoveryCapabilities {
	reasoning: boolean;
	input: ("text" | "image")[];
}

export function capabilitiesForModel(id: string): ModelDiscoveryCapabilities {
	const capabilities = lookup(MODEL_CAPABILITIES, id);
	if (!capabilities) return { reasoning: false, input: TEXT_ONLY };
	return {
		reasoning: capabilities.reasoning,
		input: capabilities.vision ? TEXT_IMAGE : TEXT_ONLY,
	};
}

export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";
