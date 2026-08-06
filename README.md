# oh-my-pi-plugin-command-code

A [Command Code](https://commandcode.ai) model provider plugin for [Oh My Pi](https://github.com/metaphorics/oh-my-pi) (omp). It exposes the ~52 models offered by the Command Code gateway through omp's provider system, talking to the real `https://api.commandcode.ai` endpoint with multi-key quota rotation.

## What it does

- Registers the `commandcode` provider against the real Command Code gateway (`https://api.commandcode.ai`), not the fabricated `/provider/v1` surface.
- Ships a static catalog of the ~52 models the Command Code CLI exposes (there is no discovery endpoint to query).
- Speaks the gateway's bespoke newline-delimited JSON streaming protocol on `POST /alpha/generate`.
- Implements the Command Code browser login flow so keys land in omp's own credential store.
- Rotates across every key stored for the provider: when one key's quota is exhausted it is blocked and the next stored key is used; when all keys are exhausted the turn fails fast with the earliest reset time rather than waiting.
- Backs off on per-second rate limits **without** rotating (a transient throttle is not a dead key).

## Install

From this repository:

```sh
omp plugin link .
```

For development, install dependencies first:

```sh
bun install
```

## Getting an API key

Command Code keys are issued by the web UI at <https://commandcode.ai/studio>. They are prefixed `user_` and **cannot be minted programmatically** — the login flow opens the browser so the web app can issue one to you.

## `/login`

Run `/login` inside omp and pick **Command Code**. The plugin:

1. Starts a local callback server on `127.0.0.1`, binding the first free port in `5959`–`5968`, serving `/callback`.
2. Opens `https://commandcode.ai/studio/auth/cli?callback=http://localhost:<port>/callback&state=<state>` in your browser.
3. Waits for the web app to `POST { apiKey, state, userId, userName, keyName }` to the callback (any payload with the wrong `state` is rejected), **or** for you to paste a `user_` key directly into the prompt — whichever comes first.
4. Validates the key against `GET /alpha/whoami` and returns it to omp, which persists it in the credential store.

`/login` establishes the **first** key for the provider. omp stores a login result by replacing the provider's credential entry, so `/login` is not the way to add more keys — use `/cc-keys add` for that.

## `/cc-keys`

Manages the Command Code key pool stored in omp's credential store.

```text
/cc-keys list              # show each key's position and last 4 chars
/cc-keys add <user_…>      # sanitize → validate against /alpha/whoami → append to the pool
/cc-keys remove <n>        # remove the key at 1-based position <n>
```

- `/cc-keys add` rejects a key already in the pool (exact match) and validates before storing.
- `/login` establishes the first key; `/cc-keys add` is the only path that grows the pool beyond one.
- A missing or unknown subcommand prints `Usage: /cc-keys list | add <user_…> | remove <n>`.
- Every subcommand errors with `Command Code: no active session yet` when run before a session has started.

## Rotation behavior

Every model request resolves a key from the credential store via `authStorage.getApiKey("commandcode", sessionId)`, which skips blocked siblings.

- **Quota exhausted** (insufficient credits, `RATE_LIMITED`, or a windowed `429` with `error.rateLimit`): the current key is blocked with `authStorage.markUsageLimitReached(...)`. If an unblocked sibling exists, the request is retried with the next key (capped at 4 distinct keys per call). If every key is blocked, the turn aborts immediately with the blocked count and the earliest reset time — it never waits.
- **Per-second rate limit** (a `429` without `error.rateLimit`, or `rate_limit_error`): the request backs off with the vendor's own exponential curve and retries with the **same** key. The key is not rotated, because a transient throttle is not a dead key.
- **Bad key** (`401` / unauthorised): the credential is rotated away and the request retried once.
- **Other errors**: retried once on `429`/`5xx`, otherwise surfaced as a terminal error.

A partial turn already on the wire is never replayed — once any content has been streamed, a failure becomes a terminal error rather than a retry, so you never get duplicated output.

## Environment variables

|Variable|Purpose|
|---|---|
|`COMMANDCODE_API_ENV`|Select the gateway host: `prod` (default) → `https://api.commandcode.ai`, `staging` → `https://staging-api.commandcode.ai`, `local` → `http://localhost:9090`. Unknown or unset values fall back to `prod`.|
|`COMMANDCODE_API_URL`|Override the base URL entirely. Only honored when `COMMANDCODE_SANDBOX` is `true`.|
|`COMMANDCODE_SANDBOX`|Set to `true` to allow `COMMANDCODE_API_URL` to take effect.|

## Notes

- Command Code bills its own credits, not per-token USD, so every model in the catalog reports a zero cost. The provider reports real token usage from the gateway's `finish` event.
- The model catalog is a snapshot of `command-code@1.14.0`. When Command Code adds models, `src/models.ts` must be regenerated from a newer bundle; there is no discovery endpoint to automate it.
- `~/.commandcode/auth.json` and `COMMAND_CODE_API_KEY` are **not** read. Keys enter only through `/login` and `/cc-keys add`.

## License

MIT
