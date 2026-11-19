# Broker contract (credentials, grants, identity)

**0.1-draft.** The broker holds the person's secrets and acts on them under **grants** the person approves with a **passkey**. The agent never holds a raw secret: it asks the broker to *do* something, and the broker does it and returns the result with no secret in it.

## Concepts

- **Credential:** a named secret in the store (a login, an OAuth token, an API key). It's referred to only by name, for example `opentable`.
- **Grant:** permission to use one credential for a set of operations, under constraints, until it expires or is used up. Each grant's lifecycle is:
  `pending` → `approved` | `denied` | `expired` → (`consumed` | `revoked` | `expired`)
- **Standing grant:** reusable until `expires_at`. Use it for searching and logging in.
- **One-shot grant:** consumed by its first successful use. **Every booking, purchase or other binding act needs its own one-shot grant** whose constraints match the act exactly.
- **Approval:** the person opens `approve_url` and approves with a passkey (WebAuthn, user verification required). The assertion is bound to the grant's id and a hash of its contents, so it can't be replayed onto another grant.
- **Proxy, not mint.** The broker calls services with the secret itself. It never mints a new credential for the agent.

## Operations

### `grant.request`

Ask for a grant. The broker creates it as `pending` and returns a link for the person.

| args | |
|---|---|
| `credential` | string: the credential name |
| `ops` | string[]: what the grant allows, e.g. `["search", "login"]` or `["book"]` |
| `constraints` | object: what the ops are limited to. For `book`, required: `venue`, `date`, `time`, `party_size`; optional `notes` |
| `mode` | `"standing"` or `"one_shot"`. `book` and any other binding op must be `one_shot` |
| `ttl_seconds` | integer: how long it stays valid once approved. Max 7 days for standing, 1 hour for one-shot |
| `purpose` | string: one plain sentence shown to the person on the approval page |

result: `{ "grant_id", "state": "pending", "approve_url", "summary" }`. `summary` is the plain-language text the approval page shows; the core should send it with the link.

### `grant.status`

args `{ "grant_id" }` → result `{ "grant_id", "state", "approved_at", "expires_at", "uses", "last_used_at" }`

### `grant.revoke`

args `{ "grant_id", "reason" }` → result `{ "grant_id", "state": "revoked" }`. The person can also revoke from the approval page.

### `mcp.call`

Call a tool on a remote MCP server using a credential the broker holds.

args `{ "grant_id", "server", "tool", "arguments" }` → result `{ "content" }`, the tool's result, with any credential material removed.

- Refused unless the grant is `approved`, covers `server`, and covers the op the tool maps to.
- A tool that maps to a binding op needs a one-shot grant whose constraints match the call's arguments exactly.

### `browser.*`

The browser worker's operations ([browser-worker.md](browser-worker.md)) are called **through the broker**, which checks the grant and then forwards them. The core never talks to the browser worker directly.

### `identity.sign`

Sign bytes with the **agent's** key, which is separate from the broker's own key. The broker holds it; the agent uses it.

args `{ "purpose": "caller_proof" | "declaration" | "http_request", "payload_b64" }` → result `{ "kid", "alg": "Ed25519", "sig_b64" }`

### `identity.declaration`

Produce the declaration the agent *would* present to a relying party for an act: who operates it, which agent it is, and what it's doing. Used to log the declaration next to an act on a site that has nowhere to receive one.

args `{ "relying_party", "act", "grant_id" }` → result `{ "declaration", "kid", "sig_b64", "presented": false }`

`declaration` is a JSON object (operator, agent key id, relying party, act, grant id, time). Its format will follow the Groundmark core spec once that is final. Until then it's marked `"format": "opa-draft-0"`.

### `status`

args `{}` → result `{ "version", "store", "agent_kid", "broker_kid" }`

## Caller proof

Requests from the core to the broker carry `sig`: an Ed25519 signature by the agent key over the request with `sig` removed, serialised in canonical JSON (RFC 8785). The broker rejects unsigned or badly signed requests from `core` with `unauthorized_caller`. So `caller` is proven rather than claimed.

## Errors

`grant_not_found`, `grant_not_approved`, `grant_denied`, `grant_expired`, `grant_revoked`, `grant_consumed`, `op_not_granted`, `constraint_mismatch`, `one_shot_required`, `credential_not_found`, `store_unavailable`, `upstream_error`, `approval_timeout`, plus the common errors.

## Log

Every grant event, approval, use, refusal and revocation is appended to the action log ([history.md](history.md)), signed by the **broker's** key.

## Store seam (internal)

The broker reads secrets through one interface:

```
CredentialStore.get(name) -> { record, secret }
```

`secret` is wrapped so it can't be printed or serialised by accident. Implementations: `FixtureCredentialStore` (tests) and a Vaultwarden/Bitwarden store (`bw serve`). Another vault is another implementation of this one method.

## Fixture

A broker fixture that approves grants automatically, uses a fixture store with fake values, signs with a throwaway key, and proxies to a fake MCP server and a static fake booking site.
