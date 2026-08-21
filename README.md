# omp-commandcode-provider

A [Command Code](https://commandcode.ai) model provider plugin for [omp](https://github.com/can1357/oh-my-pi).

This repository is a fork of [`metaphorics/oh-my-pi-plugin-command-code`](https://github.com/metaphorics/oh-my-pi-plugin-command-code), crediting upstream authors. The dynamic model catalog discovery mechanism comes from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider).

## Features

- Registers the `commandcode` provider against the Command Code gateway (`https://api.commandcode.ai`).
- Discovers the model catalog dynamically at session start rather than shipping a static list.
- Relies on omp's host-side SQLite model cache with automatic fallback when a fetch fails.
- Streams gateway traffic as newline-delimited JSON on `POST /alpha/generate`.
- Implements the Command Code browser login flow so keys persist in omp's credential store.
- Rotates across stored keys when a key exhausts its quota and fails fast when no unblocked key remains.
- Backs off on per-second rate limits and keeps the same key.

<!-- vale Vale.Terms = NO -->

## Model catalog discovery and caching

### Discovery endpoint

<!-- vale Vale.Terms = YES -->

At session start, the plugin queries the keyless discovery endpoint:

`GET https://api.commandcode.ai/provider/v1/models`

Request header: `accept: application/json`

The endpoint returns JSON in this format:

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

The host caches the catalog, not the plugin:

- omp's `fetchDynamicModels` mechanism runs the fetch through the same SQLite model cache that built-in providers use, with a 24-hour TTL.
- When a fetch fails or times out, the host serves the cached catalog.

<!-- vale Vale.Terms = NO -->

### Model capabilities and fallback

<!-- vale Vale.Terms = YES -->

The discovery endpoint returns only `id`, `name`, and `context_length`. It omits `reasoning` and vision flags.

- The local capability snapshot in `src/models.ts` supplies the vision and `reasoning` flags for known models.
- The plugin treats each newly discovered model ID that the snapshot omits as text-only (`input: ["text"]`) and non-reasoning (`reasoning: false`).

The snapshot transcribes capabilities from the model registry in `command-code@1.26.0` and cross-checks them against the capability labels on `https://commandcode.ai/docs/reference/cli/models`. An audit corrected 11 incorrect `reasoning` flags (`moonshotai/Kimi-K3`, `moonshotai/Kimi-K2.7-Code`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `MiniMaxAI/MiniMax-M3`, `Qwen/Qwen3.7-Max`, `Qwen/Qwen3.7-Plus`, `Qwen/Qwen3.7-Flash`, `stepfun/Step-3.5-Flash`, `tencent/hy3-paid`, `nvidia/nemotron-3-ultra-550b-a55b`, and `thinkingmachines/inkling-small`) and added 4 missing models (`zai-org/GLM-5.3`, `google/gemini-3.7-flash`, `xai/grok-4.6`, and `Qwen/Qwen3.8-27B`).

Two model IDs resolve against a single source. `Qwen/Qwen3.8-27B` postdates the bundled registry and takes its capabilities from the documented label "Text input, Vision, Reasoning." `claude-sonnet-4-6` lists the levels `low`, `medium`, `high`, `xhigh`, and `max` in the bundle and in the vendor reference, while the documentation label omits reasoning. The snapshot records it as a reasoning model.
<!-- vale Vale.Terms = NO -->

## Model pricing

<!-- vale Vale.Terms = YES -->

The discovery endpoint publishes no pricing metadata. The plugin transcribes rates from the two vendor documentation pages in `PRICING_SOURCE_URLS` (`https://commandcode.ai/models` and `https://commandcode.ai/docs/resources/pricing-limits`) and stamps them with `PRICING_VERIFIED_ON` (`2026-08-19`).

All rates are in USD per million tokens, matching the unit omp expects. The vendor resolves running promotions into its advertised price list, so the table records a discounted model at its active promotional rate. A model ID that the pricing table does not carry falls back to zero, which omp's model browser renders as "free." When upstream adds new models, the pricing table requires an update before model costs display accurately.

omp bills from a single flat rate per model and supports no context-length tiers or time-of-day schedules. The table records the entry tier and the published default rate for each model. The vendor's usage page remains the authoritative source for actual billing.

### Rates that vary

| model                                          | recorded                      | variation                                                       |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `deepseek/deepseek-v4-flash`                   | 0.22 / 0.66 / 0.007           | off-peak, 17 h a day, peak 0.44 / 1.32 at 01–04 and 06–10 UTC   |
| `deepseek/deepseek-v4-pro`                     | 0.66 / 1.98 / 0.022           | off-peak, 17 h a day, peak 1.32 / 3.96 at 01–04 and 06–10 UTC   |
| `Qwen/Qwen3.7-Flash`                           | 0.03 / 0.13 / 0.006 / 0.038   | higher tiers more than 32K and more than 256K input tokens      |
| `Qwen/Qwen3.7-Plus`                            | 0.4 / 1.6 / 0.08 / 0.5        | higher tier more than 256K input tokens                         |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | 5/30, 2/12, 0.2/1.2           | higher tier more than 272K input tokens                         |
| `google/gemini-3.7-flash`                      | 0.75 / 3.75 / 0.075 / 0.04167 | 50% promotion, ends 2026-12-31, list 1.5 / 7.5 / 0.15 / 0.08334 |
| `MiniMaxAI/MiniMax-M3`                         | 0.3 / 1.2 / 0.06              | 50% promotion, list 0.6 / 2.4 / 0.12                            |
| `xiaomi/mimo-v2.5`                             | 0.14 / 0.28 / 0.0028          | 98% discount, list 0.8 / 4 / 0.16                               |
| `xiaomi/mimo-v2.5-pro`                         | 0.435 / 0.87 / 0.0036         | 99% discount, list 2 / 6 / 0.4                                  |
| `meta/muse-spark-1.2-contributor`              | 0.1 / 0.2 / 0.002             | Muse Spark 1.2 at about 95% off                                 |
| `poolside/laguna-s-2.1-free`                   | 0 / 0 / 0                     | genuinely free                                                  |

## Install

```bash
omp plugin install https://github.com/riicodespretty/omp-commandcode-provider
```

The package is not on npm. Install it from this repository.

## Get an API key

The web interface at <https://commandcode.ai/studio> issues Command Code keys, and each key starts with `user_`. Only the web application can issue keys, so the login flow opens the browser for it to issue one.

## `/login`

Run `/login` inside omp and select **Command Code**. The plugin:

1. Starts a local HTTP server on `127.0.0.1`, binding the first available port in the range `5959`–`5968`, serving `/callback`.
2. Opens `https://commandcode.ai/studio/auth/cli?callback=http://localhost:<port>/callback&state=<state>` in your browser.
3. Waits for the web application to `POST { apiKey, state, userId, userName, keyName }` to the callback URL, or for you to paste a `user_` key directly into the terminal prompt.
4. Validates the key against `GET /alpha/whoami` and returns it to omp to store in the credential store.

Run `/login` again with a different key to add another key to the provider's credential pool. A submitted key that matches a key in the pool updates that entry in place.

## `/logout`

Run `/logout` and select **Command Code** to examine stored keys and remove one. Rows carry the label `API key #<id>`, with the active credential first.

## Rotation behavior

Each model request resolves its API key through omp's `ApiKeyResolver`, which skips blocked keys and manages the retry policy:

- **Quota exhausted** (low credits, `RATE_LIMITED`, or a windowed `429` with `error.rateLimit`): the plugin marks the current key as usage-limited through `authStorage.markUsageLimitReached(...)` with Command Code's reset window. If an unblocked key exists, the request retries with that key (capped at four quota failures per call, allowing up to three rotations). If no key remains usable, the turn fails immediately with the count of blocked keys and the earliest reset time.
- **Per-second rate limit** (a `429` without `error.rateLimit`, or `rate_limit_error`): the request backs off exponentially and retries with the same key. No rotation occurs.
- **Bad key** (`401`): the resolver executes its refresh-then-rotate steps and retries as soon as a different key is available.
- **Other errors**: the resolver retries the HTTP status codes `429` and `5xx` once. Other failures end the turn.

When the gateway starts streaming on a turn, the plugin treats a subsequently reported error as terminal rather than retrying it, preventing duplicated output.

## `/usage`

The plugin feeds the host's built-in `/usage` command with real Command Code account usage. When the session starts, the plugin wraps the host's `fetchUsageReports` on the auth storage instance. The wrapper resolves a stored Command Code API key, queries the account, and appends a `commandcode` usage report to the host's existing reports.

The plugin builds the report from four gateway endpoints:

| Endpoint                                                   | Function                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /alpha/whoami`                                        | Resolves the account's org ID and login.                               |
| `GET /alpha/billing/credits?orgId=<id>`                    | Current monthly, purchased, and free credit balances plus the plan ID. |
| `GET /alpha/billing/subscriptions?orgId=<id>`              | Billing period start and end.                                          |
| `GET /alpha/usage/summary?orgId=<id>&since=<period start>` | USD cost accumulated since the period start.                           |

The report renders:

- **Command Code Credits**—the combined balance (monthly plus purchased plus free), the cost spent since the billing period started, and a used fraction. The status is `ok` less than 80% used, `warning` from 80% up, and `exhausted` at 100%. The reset time is the billing period end.
- **Plan**—the monthly credit limit for the active plan, when known.
- **Usage since period start**—the accumulated USD cost, with the top models by cost when the summary provides them.

Each request uses the resolved base URL and the same headers as model traffic, forwards the host's cancel signal, and runs through the host credential store. A failed request degrades to no report rather than an error: `/usage` then falls back to the host's session token tallies, which the plugin's per-turn cost tracking (`readWireUsage` in `src/stream.ts`) feeds from the gateway's `finish` event.

### Status line

The report also drives the host's status-line `usage` segment when Command Code is the active provider. It carries `7d` and `5h` windowed limits with the same used fraction as the credits limit, which the host renders as `7d <pct>%` and `5h <pct>%` with the billing-period reset.

The `cache_hit` segment reads the session's summed `cacheRead / (cacheRead + cacheWrite + input)`. The plugin splits cached tokens out of the gateway's `inputTokens` when the wire reports them inside it (OpenAI-style), and keeps them separate when the gateway reports them additively (Anthropic-style)—so the rate reflects the real hit ratio rather than capping at 50%.

The `token_rate` segment shows the last assistant turn's throughput (`output / duration`), as the host computes it. This is not a moving average across turns. A session-level average requires a host-side change.

## Environment variables

| Variable                        | Function                                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMANDCODE_MODELS_URL`        | Override the model discovery URL. Defaults to `<base_url>/provider/v1/models`.                                                                                                                                             |
| `COMMANDCODE_MODELS_TIMEOUT_MS` | Timeout for model discovery requests in milliseconds. Defaults to `10000` (10 seconds).                                                                                                                                    |
| `COMMANDCODE_API_ENV`           | Select the gateway host: `prod` (default) &rarr; `https://api.commandcode.ai`, `staging` &rarr; `https://staging-api.commandcode.ai`, `local` &rarr; `http://localhost:9090`. Unknown or unset values fall back to `prod`. |
| `COMMANDCODE_API_URL`           | Override the base URL fully. Active only when `COMMANDCODE_SANDBOX` is `true`.                                                                                                                                             |
| `COMMANDCODE_SANDBOX`           | Set to `true` to allow `COMMANDCODE_API_URL` to take effect.                                                                                                                                                               |

## Notes

- The gateway reports token usage in its `finish` event.
- The plugin does not read `~/.commandcode/auth.json` or `COMMAND_CODE_API_KEY` and manages keys only through `/login`.
- The gateway's `x-session-id` header carries omp's session ID, read fresh on each request. `/session new` resets the session ID and the sticky credential selection together.

## License

MIT
