# Router

The one place the agent talks to a model ([contract](../../contracts/router.md)). One neutral request in on `POST http://127.0.0.1:<port>/infer`, whichever provider `router.toml` names out. Swapping models is one edited line.

**Status:** working. No runtime dependencies (Node 22 built-ins only).

**Adapters** (one file each, in `src/adapters/`):
- `openai.js`: any OpenAI-compatible endpoint. Covers OpenRouter (and through it Claude, GPT and others), OpenAI, and local model servers.
- `replay.js`: answers recorded earlier, keyed by a hash of the request. No network, no key. Set `[server] record = "<file>"` to record live answers.
- Still to come: a direct Anthropic adapter (on the official SDK).

**Setup**
```
cp router.example.toml router.toml   # pick models
CREDENTIALS_DIRECTORY=/path/to/dir npm start   # dir holds a file per credential, e.g. inference-openrouter
```
Under systemd, use `LoadCredential=inference-openrouter:/etc/opa/credentials/inference-openrouter`, so the key never sits in the environment or the config.

**What it logs:** one JSON line per call (`[server] log`): time, `errand_id`, caller, logical model, provider, provider model, stop, token counts, duration, error code. Never prompts, replies or keys.

**Per model, optional:** `max_tokens` (the reply limit when the caller sets none; with neither, the provider's own default applies) and `timeout_s` (default 120, covering the whole exchange with the provider).

**Errors:** `unknown_model`, `rate_limited` (HTTP 429), `context_too_long` (only when the input is too long), `provider_error` (anything else, including OpenRouter's upstream errors that arrive with HTTP 200, and any reply that is malformed, over 8 MiB, or ends for a reason other than stop, tool calls, length or content filter), `credential_unavailable`, plus the common errors. Messages are fixed text: the provider's own error text isn't passed on or logged, since it can quote the prompt.

**Never stops for one bad call:** a call log or recording that can't be written is reported on stderr and the call goes on; a caller that hangs up mid-request is dropped.

**Narrower than the 0.4 schema:** each role takes only the parts the adapters can translate faithfully. `user`: text. `assistant`: text and `tool_call`. `tool`: `tool_result` parts only, so a tool message given as a plain string is refused (it has no `call_id` to answer). Anything else is `bad_request` instead of being dropped silently. The 0.4 schema allows any part under any role; the narrower rule is proposed for contracts 0.5.

```
npm test   # 18 tests, ~1.5 s. Includes the fixture errand through this router, replaying Haiku 5.5's recorded answers
```

**Open question:** the contract says the provider key comes "through `CredentialStore`", which is internal to the broker. Until that's settled, `src/credentials.js` reads systemd credentials.
