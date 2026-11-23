# Broker contract (credentials, grants, identity)

**0.2-draft.** The broker holds the person's secrets and acts on them under **grants** the person approves with a **passkey**. The agent never holds a raw secret: it asks the broker to *do* something, and the broker does it and returns the result with no secret in it.

## Concepts

- **Credential:** a named secret in the store (a login, an OAuth token, an API key). It's referred to only by name, for example `opentable`.
- **Operator session:** a site the person is signed in to in their own browser, named by its origin, for example `https://shop.example`. The broker holds no secret for it. The browser worker reaches it in `operator_browser` mode ([browser-worker.md](browser-worker.md)).
- **Grant:** permission to use **one credential or one operator session** for a set of operations, under constraints, until it expires or is used up. Each grant's lifecycle is:
  `pending` → `approved` | `denied` | `expired` → (`consumed` | `revoked` | `expired`)
- **Ops** a grant can carry:

  | op | What it allows | Binding? |
  |---|---|---|
  | `read` | Look at the person's own account data on the site: orders, subscriptions, bookings, history | no |
  | `search` | Look at public listings: availability, prices, menus | no |
  | `login` | Sign in with the credential (`fill_login`) or wait for the person to (`await_login`) | no |
  | `book` | Make a reservation | yes |
  | `edit_order` | Change a standing order: quantities, items, skips | yes |
  | `pay` | Pay | yes |

- **Standing grant:** reusable until `expires_at`. Use it for `read`, `search` and `login`.
- **One-shot grant:** consumed by its first successful use. **Every binding op needs its own one-shot grant** whose constraints match the act exactly.
- **Approval:** the person opens `approve_url` and approves with a passkey (WebAuthn, user verification required). The assertion is bound to the grant's id and a hash of its contents, so it can't be replayed onto another grant.
- **Proxy, not mint.** The broker calls services with the secret itself. It never mints a new credential for the agent.

## Operations

### `grant.request`

Ask for a grant. The broker creates it as `pending` and returns a link for the person.

| args | |
|---|---|
| `credential` | string: the credential name. **Exactly one of `credential` or `session`** |
| `session` | `{ "origin", "browser": "operator" }`: an operator session, instead of a credential |
| `ops` | string[]: what the grant allows, from the table above |
| `constraints` | object: what the ops are limited to. For `book`, required: `venue`, `date`, `time`, `party_size`; optional `notes`. For `edit_order`, required: `changes` (a list of `{ item, quantity }` or `{ skip: "<date>" }`). For `read`, optional: `scope` (for example `"orders"`), shown to the person |
| `mode` | `"standing"` or `"one_shot"`. Binding ops must be `one_shot` |
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

| op | The grant must allow |
|---|---|
| `browser.open`, `browser.act` (non-binding), `browser.extract` | `read` or `search` |
| `browser.fill_login`, `browser.await_login` | `login` |
| the binding `browser.act` | a one-shot grant for the binding op, passed as `book_grant_id` |
| `browser.close` | any live grant |

- **Origin.** For a session grant, the broker refuses any `browser.*` call whose URL or session is on another origin (`origin_mismatch`). For a credential grant, the origin is the credential's recorded origin.
- **A `read`-only grant opens read-only sessions.** If the grant allows `read` but not `search` or `login`, the broker forces `read_only: true` on `browser.open`.
- **Sessions end with their grant.** On expiry or revocation the broker closes every browser session opened under that grant.

### `identity.sign`

Sign bytes with the **agent's** key, which is separate from the broker's own key. The broker holds it; the agent uses it.

args `{ "purpose": "declaration" | "http_request", "payload_b64" }` → result `{ "kid", "alg": "Ed25519", "sig_b64" }`

### `identity.declaration`

Produce the declaration the agent *would* present to a relying party for an act: who operates it, which agent it is, and what it's doing. Used to log the declaration next to an act on a site that has nowhere to receive one.

args `{ "relying_party", "act", "grant_id" }` → result `{ "declaration", "kid", "sig_b64", "presented": false }`

`declaration` is a JSON object (operator, agent key id, relying party, act, grant id, time). Its format will follow the Groundmark core spec once that is final. Until then it's marked `"format": "opa-draft-0"`.

### `status`

args `{}` → result `{ "version", "store", "agent_kid", "broker_kid" }`

## Caller proof

**0.1 had the core sign its requests with the agent key, which the broker holds. That proved nothing: anyone who could reach the socket could ask the broker for the signature.** 0.2 proves the caller with the operating system instead:

- **One socket per caller.** The broker listens on a separate socket for each part allowed to call it: `broker-core.sock`, `broker-channel-signal.sock`, and so on. **The deployment must make sure only that caller can open its socket.** The contract doesn't fix how. Any of these will do:
  - **Separate Unix users,** with each socket `0600` to its caller. This suits a single person's agent on their own machine.
  - **systemd `DynamicUser=`,** which gives each service its own uid automatically, with no accounts to create or manage.
  - **One container or sandbox per part,** with each socket mounted only into its caller's container. This suits a host running many people's agents.
- **Isolation between people comes first.** On a host running many agents, every person's parts and sockets live in that person's own sandbox. Separating parts within one agent is the second layer: it keeps a compromised core away from the broker's secrets.
- **The socket is the caller.** The broker takes the caller from the socket the request arrived on. If the envelope's `caller` field differs, it refuses with `unauthorized_caller`.
- **Peer credentials are a second check, where available.** On Linux the broker may also read `SO_PEERCRED` and refuse a peer whose uid isn't the one configured for that socket.
- **Remote parts** (a browser worker on the person's laptop) are reached the other way round: the broker signs each call with the **broker** key, and the worker verifies it. That signature is real proof, because only the broker holds the key.

The envelope's `sig` field stays, for seams that cross machines.

## Errors

`grant_not_found`, `grant_not_approved`, `grant_denied`, `grant_expired`, `grant_revoked`, `grant_consumed`, `op_not_granted`, `constraint_mismatch`, `one_shot_required`, `origin_mismatch`, `credential_not_found`, `store_unavailable`, `upstream_error`, `approval_timeout`, plus the common errors.

## Log

Every grant event, approval, use, refusal and revocation is appended to the action log ([history.md](history.md)), signed by the **broker's** key. `grant.used` entries for browser ops carry `mode`, `login_mode` (`broker_filled` or `operator_filled`) where a login happened, and `conforming`.

## Store seam (internal)

The broker reads secrets through one interface:

```
CredentialStore.get(name) -> { record, secret }
```

`secret` is wrapped so it can't be printed or serialised by accident. Implementations: `FixtureCredentialStore` (tests) and a Vaultwarden/Bitwarden store (`bw serve`). Another vault is another implementation of this one method.

## Fixture

A broker fixture that approves grants automatically, uses a fixture store with fake values, signs with a throwaway key, listens on one socket per caller, and proxies to a fake MCP server and a static fake site.
