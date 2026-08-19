/**
 * Command Code model capabilities and default configuration.
 *
 * The catalog is discovered dynamically from the provider endpoint;
 * this module provides the static reasoning and vision capability
 * snapshot that the discovery endpoint does not expose.
 */

export interface ModelCapabilities {
	reasoning: boolean;
	vision: boolean;
}

export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
	"claude-sonnet-5": { reasoning: true, vision: true },
	"claude-sonnet-4-6": { reasoning: true, vision: true },
	"claude-fable-5": { reasoning: true, vision: true },
	"claude-opus-5": { reasoning: true, vision: true },
	"claude-opus-4-8": { reasoning: true, vision: true },
	"claude-opus-4-7": { reasoning: true, vision: true },
	"claude-haiku-4-5-20251001": { reasoning: false, vision: true },
	"gpt-5.6-sol": { reasoning: true, vision: true },
	"gpt-5.6-terra": { reasoning: true, vision: true },
	"gpt-5.6-luna": { reasoning: true, vision: true },
	"gpt-5.5": { reasoning: true, vision: true },
	"gpt-5.4": { reasoning: true, vision: true },
	"gpt-5.3-codex": { reasoning: true, vision: true },
	"gpt-5.4-mini": { reasoning: true, vision: true },
	"deepseek/deepseek-v4-pro": { reasoning: true, vision: false },
	"deepseek/deepseek-v4-flash": { reasoning: true, vision: false },
	"moonshotai/Kimi-K3": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.7-Code": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.7-Code-Highspeed": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.6": { reasoning: false, vision: true },
	"moonshotai/Kimi-K2.5": { reasoning: false, vision: true },
	"zai-org/GLM-5.2": { reasoning: true, vision: false },
	"zai-org/GLM-5.2-Fast": { reasoning: false, vision: false },
	"zai-org/GLM-5.1": { reasoning: false, vision: false },
	"zai-org/GLM-5": { reasoning: false, vision: false },
	"MiniMaxAI/MiniMax-M3": { reasoning: false, vision: true },
	"MiniMaxAI/MiniMax-M2.7": { reasoning: false, vision: false },
	"MiniMaxAI/MiniMax-M2.5": { reasoning: false, vision: false },
	"xiaomi/mimo-v2.5-pro": { reasoning: false, vision: false },
	"xiaomi/mimo-v2.5": { reasoning: false, vision: true },
	"Qwen/Qwen3.8-Max": { reasoning: true, vision: true },
	"Qwen/Qwen3.7-Max": { reasoning: false, vision: false },
	"Qwen/Qwen3.7-Plus": { reasoning: false, vision: true },
	"Qwen/Qwen3.7-Flash": { reasoning: false, vision: true },
	"Qwen/Qwen3.6-Max-Preview": { reasoning: true, vision: false },
	"Qwen/Qwen3.6-Plus": { reasoning: true, vision: true },
	"stepfun/Step-3.7-Flash": { reasoning: true, vision: true },
	"stepfun/Step-3.5-Flash": { reasoning: false, vision: false },
	"tencent/hy3-paid": { reasoning: false, vision: false },
	"google/gemini-3.6-flash": { reasoning: true, vision: true },
	"google/gemini-3.5-flash": { reasoning: true, vision: true },
	"google/gemini-3.5-flash-lite": { reasoning: true, vision: true },
	"google/gemini-3.1-flash-lite": { reasoning: true, vision: true },
	"sakana/fugu-ultra": { reasoning: true, vision: true },
	"nvidia/nemotron-3-ultra-550b-a55b": { reasoning: false, vision: false },
	"thinkingmachines/inkling": { reasoning: true, vision: true },
	"thinkingmachines/inkling-small": { reasoning: false, vision: true },
	"poolside/laguna-s-2.1-free": { reasoning: true, vision: false },
	"meta/muse-spark-1.1": { reasoning: true, vision: true },
	"meta/muse-spark-1.2": { reasoning: true, vision: true },
	"meta/muse-spark-1.2-contributor": { reasoning: true, vision: true },
	"xai/grok-4.5": { reasoning: true, vision: true },
};

const TEXT_IMAGE: ("text" | "image")[] = ["text", "image"];
const TEXT_ONLY: ("text" | "image")[] = ["text"];

export function capabilitiesForModel(id: string): {
	reasoning: boolean;
	input: ("text" | "image")[];
} {
	const cap = MODEL_CAPABILITIES[id];
	if (!cap) {
		return { reasoning: false, input: TEXT_ONLY };
	}
	return {
		reasoning: cap.reasoning,
		input: cap.vision ? TEXT_IMAGE : TEXT_ONLY,
	};
}

export const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

/** The vendor's `qn` default. */
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";
