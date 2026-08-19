# omp-commandcode-provider

A [Command Code](https://commandcode.ai) model provider plugin for [Oh My Pi](https://github.com/can1357/oh-my-pi) (omp).

This repository is a fork of [`metaphorics/oh-my-pi-plugin-command-code`](https://github.com/metaphorics/oh-my-pi-plugin-command-code), crediting upstream authors. The dynamic model catalog discovery mechanism is adapted from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider).

## Features

- Registers the `commandcode` provider against the Command Code gateway (`https://api.commandcode.ai`).
- Discovers the model catalog dynamically at session start instead of shipping a static list.
- Relies on omp's host-side SQLite model cache with automatic fallback on fetch failure.
- Communicates with the gateway using newline-delimited JSON streaming on `POST /alpha/generate`.
- Implements the Command Code browser login flow so keys persist in omp's credential store.
- Rotates across stored keys when quota is exhausted and fails fast when all keys are blocked.
- Backs off on per-second rate limits without rotating keys.

## Model catalog discovery and caching

### Discovery endpoint

At session start, the plugin queries the keyless discovery endpoint:

`GET https://api.commandcode.ai/provider/v1/models`

Request header: `accept: application/json`

The endpoint returns JSON in the following format:

```json
{
	"object": "list",
	"data": [
		{
			"id": "claude-sonnet-5",
			"object": "model",
			"created": 1787133935,
			"owned_by": "command-code",
			"name": "Claude Sonnet 5",
			"context_length": 1000000
		}
	]
}
```

### Host-managed caching

Caching is handled by Oh My Pi rather than by the plugin:

- Oh My Pi's `fetchDynamicModels` mechanism runs the fetch through the same SQLite model cache used by built-in providers, with a 24-hour TTL.
- When a fetch fails or times out, the host serves the cached catalog.
- The plugin maintains no cache file or local persistence of its own.
- To pick up a refreshed catalog before the TTL expires, restart omp. Provider registrations are drained once when the process initializes its session, so the host does not support live in-session catalog re-registration.

### Model capabilities and fallback

The discovery endpoint provides only `id`, `name`, and `context_length`. It does not provide `reasoning` or vision flags.

- Reasoning and vision capabilities for known models are looked up from a local capability snapshot in `src/models.ts`.
- Any newly discovered model ID not present in the snapshot is treated conservatively as text-only (`input: ["text"]`) and non-reasoning (`reasoning: false`).

Capabilities are transcribed from the model registry bundled in `command-code@1.26.0` and cross-checked against the capability labels on `https://commandcode.ai/docs/reference/cli/models`. An audit corrected 11 wrong `reasoning` flags (`moonshotai/Kimi-K3`, `moonshotai/Kimi-K2.7-Code`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `MiniMaxAI/MiniMax-M3`, `Qwen/Qwen3.7-Max`, `Qwen/Qwen3.7-Plus`, `Qwen/Qwen3.7-Flash`, `stepfun/Step-3.5-Flash`, `tencent/hy3-paid`, `nvidia/nemotron-3-ultra-550b-a55b`, and `thinkingmachines/inkling-small`) and added 4 missing models (`zai-org/GLM-5.3`, `google/gemini-3.7-flash`, `xai/grok-4.6`, and `Qwen/Qwen3.8-27B`).

Two model IDs resolve against a single source: `Qwen/Qwen3.8-27B` postdates the bundled registry and takes its capabilities from the documented label "Text input, Vision, Reasoning"; `claude-sonnet-4-6` has an explicit effort list (`low`, `medium`, `high`, `xhigh`, `max`) in the bundle and in the vendor reference while the documentation label omits reasoning, so it is recorded as reasoning.

Reasoning effort levels are not modelled. The plugin's stream only sends `low`, `medium`, or `high`, while the vendor lists `xhigh` and `max` for some models, so no per-model thinking-effort map is advertised.

## Model pricing

The discovery endpoint publishes no pricing metadata. Rates are transcribed from the two vendor documentation pages in `PRICING_SOURCE_URLS` (`https://commandcode.ai/models` and `https://commandcode.ai/docs/resources/pricing-limits`) and stamped with `PRICING_VERIFIED_ON` (`2026-08-19`).

All rates are in USD per million tokens, matching the unit Oh My Pi expects. The vendor resolves running promotions into its advertised price list, so a discounted model is recorded at its active promotional rate. A model ID that the pricing table does not carry falls back to zero, which Oh My Pi's model browser renders as "free". When new models are added upstream, the pricing table requires an update before model costs display accurately.

Oh My Pi bills from a single flat rate per model and supports no context-length tiers or time-of-day schedules. The table records the entry tier and the published default rate for each model. The vendor's usage page remains the authoritative source for actual billing.

### Rates that vary

| model | recorded | variation |
|---|---|---|
| `deepseek/deepseek-v4-flash` | 0.22 / 0.66 / 0.007 | off-peak, 17 h a day; peak 0.44 / 1.32 at 01–04 and 06–10 UTC |
| `deepseek/deepseek-v4-pro` | 0.66 / 1.98 / 0.022 | off-peak, 17 h a day; peak 1.32 / 3.96 at 01–04 and 06–10 UTC |
| `Qwen/Qwen3.7-Flash` | 0.03 / 0.13 / 0.006 / 0.038 | higher tiers above 32K and above 256K input tokens |
| `Qwen/Qwen3.7-Plus` | 0.4 / 1.6 / 0.08 / 0.5 | higher tier above 256K input tokens |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | 5/30, 2/12, 0.2/1.2 | higher tier above 272K input tokens |
| `google/gemini-3.7-flash` | 0.75 / 3.75 / 0.075 / 0.04167 | 50% promotion, ends 2026-12-31; list 1.5 / 7.5 / 0.15 / 0.08334 |
| `MiniMaxAI/MiniMax-M3` | 0.3 / 1.2 / 0.06 | 50% promotion; list 0.6 / 2.4 / 0.12 |
| `xiaomi/mimo-v2.5` | 0.14 / 0.28 / 0.0028 | 98% discount; list 0.8 / 4 / 0.16 |
| `xiaomi/mimo-v2.5-pro` | 0.435 / 0.87 / 0.0036 | 99% discount; list 2 / 6 / 0.4 |
| `meta/muse-spark-1.2-contributor` | 0.1 / 0.2 / 0.002 | Muse Spark 1.2 at about 95% off |
| `poolside/laguna-s-2.1-free` | 0 / 0 / 0 | genuinely free |

## Install

```bash
omp plugin install https://github.com/riicodespretty/omp-commandcode-provider
```

The package is not published to npm; install it from this repository.

## Getting an API key

Command Code keys are issued by the web interface at <https://commandcode.ai/studio>. They are prefixed with `user_` and cannot be generated programmatically. The login flow opens the browser so the web application can issue a key.

## `/login`

Run `/login` inside omp and select **Command Code**. The plugin:

1. Starts a local HTTP server on `127.0.0.1`, binding the first available port in the range `5959`–`5968`, serving `/callback`.
2. Opens `https://commandcode.ai/studio/auth/cli?callback=http://localhost:<port>/callback&state=<state>` in your browser.
3. Waits for the web application to `POST { apiKey, state, userId, userName, keyName }` to the callback URL, or for you to paste a `user_` key directly into the terminal prompt.
4. Validates the key against `GET /alpha/whoami` and returns it to omp to store in the credential store.

Run `/login` again with a different key to add another key to the provider's credential pool. Submitting a key that is already stored updates that entry in place.

## `/logout`

Run `/logout` and select **Command Code** to list stored keys and remove one. Rows are labelled `API key #<id>`, with the active credential listed first.

## Rotation behavior

Every model request resolves its API key through omp's `ApiKeyResolver`, which skips blocked keys and manages the retry policy:

- **Quota exhausted** (insufficient credits, `RATE_LIMITED`, or a windowed `429` with `error.rateLimit`): the current key is marked as usage-limited using `authStorage.markUsageLimitReached(...)` with Command Code's reset window. If an unblocked key exists, the request retries with that key (capped at four quota failures per call, allowing up to three rotations). If all keys are blocked, the turn fails immediately with the count of blocked keys and the earliest reset time.
- **Per-second rate limit** (a `429` without `error.rateLimit`, or `rate_limit_error`): the request backs off exponentially and retries with the same key. No rotation occurs.
- **Bad key** (`401` Unauthorized): the resolver executes its refresh-then-rotate steps and retries as soon as a different key is available.
- **Other errors**: HTTP `429` and `5xx` errors are retried once; other failures terminate the turn.

Once streaming has begun on a turn, any subsequent failure is treated as a terminal error rather than retried, preventing duplicated output.

## Environment variables

| Variable | Purpose |
|---|---|
| `COMMANDCODE_MODELS_URL` | Override the model discovery URL. Defaults to `<base_url>/provider/v1/models`. |
| `COMMANDCODE_MODELS_TIMEOUT_MS` | Timeout for model discovery requests in milliseconds. Defaults to `10000` (10 seconds). |
| `COMMANDCODE_API_ENV` | Select the gateway host: `prod` (default) &rarr; `https://api.commandcode.ai`, `staging` &rarr; `https://staging-api.commandcode.ai`, `local` &rarr; `http://localhost:9090`. Unknown or unset values fall back to `prod`. |
| `COMMANDCODE_API_URL` | Override the base URL entirely. Active only when `COMMANDCODE_SANDBOX` is `true`. |
| `COMMANDCODE_SANDBOX` | Set to `true` to allow `COMMANDCODE_API_URL` to take effect. |

## Notes

- Token usage is reported from the gateway's `finish` event.
- `~/.commandcode/auth.json` and `COMMAND_CODE_API_KEY` are not read. Keys are managed exclusively through `/login`.
- The gateway's `x-session-id` header carries omp's session ID, read fresh on every request. Starting a new session with `/session new` resets the session ID and the sticky credential selection together.

## License

MIT
