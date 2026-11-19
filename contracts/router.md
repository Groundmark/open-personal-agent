# Router contract (inference)

**0.1-draft.** Gets a reply from whichever model is configured. The core speaks one small, neutral format, and the router translates it for each provider. The provider account's credential lives in the router, never in the core.

## Transport

`POST http://127.0.0.1:<port>/infer`, body = the standard envelope with `op: "infer"`. The response is the standard response. (This is the one seam on loopback HTTP, so ordinary HTTP tools work.)

## `infer`

args:

| Field | |
|---|---|
| `model` | A **logical** name from `router.toml`, e.g. `default`, `cheap`. Never a provider's model id |
| `system` | string |
| `messages` | `[{ role: "user" \| "assistant" \| "tool", content }]`. `content` is a string or a list of parts: `{ type: "text", text }`, `{ type: "tool_call", call_id, name, arguments }`, `{ type: "tool_result", call_id, content, is_error? }` |
| `tools` | `[{ name, description, parameters }]`, where `parameters` is a JSON Schema |
| `max_tokens` | integer, optional |

result:

| Field | |
|---|---|
| `content` | text parts the model produced |
| `tool_calls` | `[{ call_id, name, arguments }]` |
| `stop` | `"end"`, `"tool_calls"`, `"max_tokens"` or `"refused"` |
| `usage` | `{ input_tokens, output_tokens }` |
| `served_by` | `{ provider, model }`, for the log only. The core must not branch on it |

## Configuration

`router.toml` maps logical names to a provider adapter and model:

```toml
[models.default]
provider = "anthropic"
model = "<provider model id>"
credential = "inference-anthropic"   # a name in the credential store
```

Swapping models is one edited line. Each adapter is one file. The first is Anthropic; the second is any OpenAI-compatible endpoint (which also covers local models).

## Rules

- The provider credential is fetched through `CredentialStore`. It never appears in a request, response or log.
- Every call is logged: logical model, provider, model, token counts, `errand_id`. Prompts are not logged by default.

## Errors

`unknown_model`, `provider_error`, `rate_limited`, `context_too_long`, `credential_unavailable`, plus the common errors.

## Fixture

A scripted router that replays canned responses keyed by a hash of the request, so the end-to-end fixture errand is deterministic.
