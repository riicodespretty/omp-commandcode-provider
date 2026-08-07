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

From npm:

```bash
omp plugin install oh-my-pi-plugin-command-code
```

From this repository:

```bash
omp plugin install https://github.com/metaphorics/oh-my-pi-plugin-command-code
```

## Getting an API key

Command Code keys are issued by the web UI at <https://commandcode.ai/studio>. They are prefixed `user_` and **cannot be minted programmatically** — the login flow opens the browser so the web app can issue one to you.

## `/login`

Run `/login` inside omp and pick **Command Code**. The plugin:

1. Starts a local callback server on `127.0.0.1`, binding the first free port in `5959`–`5968`, serving `/callback`.
2. Opens `https://commandcode.ai/studio/auth/cli?callback=http://localhost:<port>/callback&state=<state>` in your browser.
3. Waits for the web app to `POST { apiKey, state, userId, userName, keyName }` to the callback (any payload with the wrong `state` is rejected), **or** for you to paste a `user_` key directly into the prompt — whichever comes first.
4. Validates the key against `GET /alpha/whoami` and returns it to omp, which persists it in the credential store.

Run `/login` again with a different key to add a second one: omp appends each distinct key to the provider's credential pool, and re-running it with a key already stored updates that row in place instead of duplicating it.

## `/logout`

Run `/logout` and pick **Command Code** to list the stored keys and remove one. Rows are labelled `API key #<id>`, active credential first. The plugin registers no key-management command of its own — adding, listing, and removing keys are all native omp operations.

## Rotation behavior

Every model request resolves its bearer through omp's own `ApiKeyResolver`, which skips blocked siblings and owns the bounded refresh-then-rotate retry policy.

- **Quota exhausted** (insufficient credits, `RATE_LIMITED`, or a windowed `429` with `error.rateLimit`): the current key is blocked with `authStorage.markUsageLimitReached(...)`, which records Command Code's own reset window. If an unblocked sibling exists, the request is retried with it (capped at 4 rotations per call). If every key is blocked, the turn aborts immediately with the blocked count and the earliest reset time — it never waits.
- **Per-second rate limit** (a `429` without `error.rateLimit`, or `rate_limit_error`): the request backs off with the vendor's own exponential curve and retries with the **same** key. No rotation is consumed, because a transient throttle is not a dead key.
- **Bad key** (`401` / unauthorised): the resolver walks its refresh-then-rotate steps; the request retries as soon as a different bearer comes back, and fails terminally when none does.
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
- `~/.commandcode/auth.json` and `COMMAND_CODE_API_KEY` are **not** read. Keys enter only through `/login`.

## License

MIT
