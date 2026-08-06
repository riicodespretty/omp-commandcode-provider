/**
 * Command Code static model catalog.
 *
 * There is no discovery endpoint — the catalog is a literal snapshot of
 * `command-code@1.14.0`. The three vendor-hidden models
 * (`MiniMaxAI/MiniMax-M3-Free`, `tencent/Hy3`, `inclusionai/ling-3.0-flash-free`)
 * are omitted.
 *
 * Command Code bills its own credits, not per-token USD, so every `cost` is
 * zero — any USD figure would be fiction. `maxTokens` is the CLI's
 * `max_tokens` default (64 000).
 */

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

import { DEFAULT_MAX_TOKENS } from "./api";

const TEXT_IMAGE: ("text" | "image")[] = ["text", "image"];
const TEXT_ONLY: ("text" | "image")[] = ["text"];

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

/** Build a catalog entry from the plan's table columns. */
function model(
	id: string,
	name: string,
	contextWindow: number,
	reasoning: boolean,
	vision: boolean,
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning,
		input: vision ? TEXT_IMAGE : TEXT_ONLY,
		cost: ZERO_COST,
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

export const COMMAND_CODE_MODELS: ProviderModelConfig[] = [
	model("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, true, true),
	model("claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, true, true),
	model("claude-fable-5", "Claude Fable 5", 1_000_000, true, true),
	model("claude-opus-5", "Claude Opus 5", 1_000_000, true, true),
	model("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, true, true),
	model("claude-opus-4-7", "Claude Opus 4.7", 1_000_000, true, true),
	model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000, false, true),
	model("gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, true, true),
	model("gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, true, true),
	model("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, true, true),
	model("gpt-5.5", "GPT-5.5", 200_000, true, true),
	model("gpt-5.4", "GPT-5.4", 400_000, true, true),
	model("gpt-5.3-codex", "GPT-5.3 Codex", 400_000, true, true),
	model("gpt-5.4-mini", "GPT-5.4 Mini", 400_000, true, true),
	model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, true, false),
	model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, true, false),
	model("moonshotai/Kimi-K3", "Kimi K3", 1_000_000, false, true),
	model("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000, false, true),
	model("moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262_000, false, true),
	model("moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000, false, true),
	model("moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000, false, true),
	model("zai-org/GLM-5.2", "GLM-5.2", 1_000_000, true, false),
	model("zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, false, false),
	model("zai-org/GLM-5.1", "GLM-5.1", 200_000, false, false),
	model("zai-org/GLM-5", "GLM-5", 200_000, false, false),
	model("MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, false, true),
	model("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000, false, false),
	model("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000, false, false),
	model("xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, false, false),
	model("xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, false, true),
	model("Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, true, true),
	model("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, false, false),
	model("Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, false, true),
	model("Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, false, true),
	model("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000, true, false),
	model("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000, true, true),
	model("stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000, true, true),
	model("stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, false, false),
	model("tencent/hy3-paid", "Tencent Hy3", 262_144, false, false),
	model("google/gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000, true, true),
	model("google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000, true, true),
	model("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000, true, true),
	model("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_000_000, true, true),
	model("sakana/fugu-ultra", "Fugu Ultra", 1_000_000, true, true),
	model("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, false, false),
	model("thinkingmachines/inkling", "Inkling", 256_000, true, true),
	model("thinkingmachines/inkling-small", "Inkling Small", 1_000_000, false, true),
	model("poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000, true, false),
	model("meta/muse-spark-1.1", "Muse Spark 1.1", 1_048_576, true, true),
	model("meta/muse-spark-1.2", "Muse Spark 1.2", 1_048_576, true, true),
	model("meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_048_576, true, true),
	model("xai/grok-4.5", "Grok 4.5", 500_000, true, true),
];

/** The vendor's `qn` default. */
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";
