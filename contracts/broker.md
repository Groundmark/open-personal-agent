# Broker contract (credentials, grants, identity)

**0.3-draft.** The broker holds the person's secrets and acts on them under **grants** the person approves with a **passkey**. The agent never holds a raw secret: it asks the broker to *do* something, and the broker does it and returns the result with no secret in it.

## Concepts

- **Credential:** a secret in the store (a login, an OAuth token, an API key). The agent refers to it either **by name** (`opentable`) or **by site** (`{ "domain": "opentable.com" }`), and never sees it. By site is how people actually ask: "use my login for this site", without registering anything first ([Credentials by site](#credentials-by-site)).
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
| `credential` | string, a credential name; or `{ "domain", "username"? }`, a login found by site. **Exactly one of `credential` or `session`** |
| `session` | `{ "origin", "browser": "operator" }`: an operator session, instead of a credential |
| `ops` | string[]: what the grant allows, from the table above |
| `constraints` | object: what the ops are limited to. For `book`, required: `venue`, `date`, `time`, `party_size`; optional `notes`. For `edit_order`, required: `changes` (a list of `{ item, quantity }` or `{ skip: "<date>" }`). For `read`, optional: `scope` (for example `"orders"`), shown to the person |
| `mode` | `"standing"` or `"one_shot"`. Binding ops must be `one_shot` |
| `ttl_seconds` | integer: how long it stays valid once approved. Max 7 days for standing, 1 hour for one-shot |
| `purpose` | string: one plain sentence shown to the person on the approval page |
| `operator_present` | boolean, default `false`: the person is at the device that runs the browser or the store's provider. Decides whether a store that asks the person on that device can be used ([Stores that ask the person themselves](#stores-that-ask-the-person-themselves)) |

result: `{ "grant_id", "state": "pending", "approve_url", "summary" }`. `summary` is the plain-language text the approval page shows; the core should send it with the link.

For a credential found by site, the result also carries `credential_ref` (the store's id for the item, once known) and `summary` names the site and, where the store can say before fetching, the item ("your login `sam@example.test` for opentable.com").

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
| `browser.fill_login`, `browser.await_login`, `browser.fill_code` | `login` |
| the binding `browser.act` | a one-shot grant for the binding op, passed as `book_grant_id` |
| `browser.close` | any live grant |

- **Origin.** For a session grant, the broker refuses any `browser.*` call whose URL or session is on another origin (`origin_mismatch`). For a credential grant, the origin is the credential's recorded origin.
- **A `read`-only grant opens read-only sessions.** If the grant allows `read` but not `search` or `login`, the broker forces `read_only: true` on `browser.open`.
- **Sessions end with their grant.** On expiry or revocation the broker closes every browser session opened under that grant.

### `browser.fill_code`

Fill a one-time code into the page: a second factor or a sign-in code. The code goes from its source to the browser worker, and **never to the core, the model or a log**.

args `{ "grant_id", "session_id", "source": "store_totp" | "person", "timeout_seconds"? }` → result `{ "filled": true }`

- The grant must allow `login`, and the session must be on the grant's origin.
- **`store_totp`:** the broker reads the TOTP for the grant's credential from the store. Refused with `op_not_granted` if the credential has none.
- **`person`:** the code goes to the person, usually by SMS or email from the site. The broker opens a **code slot** for this session and returns once the slot is filled or `timeout_seconds` passes (`code_timeout`). The core tells the person "reply with the code from <site>". The channel adapter puts the person's next message into the slot ([channel.md](channel.md#one-time-codes)), so it never reaches the core.
- A code slot takes one code and closes. Only one slot can be open per session at a time.

### `code.deliver` (channel adapters only)

args `{ "slot_id", "code" }` → result `{ "accepted": true }`. It's served only on channel adapters' sockets (`broker-channel-<name>.sock`) and refused on `broker-core.sock` (`unauthorized_caller`). `code` must be 4 to 10 characters, letters and digits only, or it's refused with `bad_request` and the slot stays open.

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

`grant_not_found`, `grant_not_approved`, `grant_denied`, `grant_expired`, `grant_revoked`, `grant_consumed`, `op_not_granted`, `constraint_mismatch`, `one_shot_required`, `origin_mismatch`, `credential_not_found`, `credential_ambiguous`, `store_no_answer`, `store_needs_operator`, `store_unavailable`, `code_timeout`, `upstream_error`, `approval_timeout`, plus the common errors.

- **`credential_not_found` covers two cases:** the item isn't there, and the person refused it on the store's own prompt. Some stores can't tell the two apart, so the contract doesn't either. The core tells the person ("I couldn't get a login for <site>") and **never retries on its own**.
- **`store_no_answer`:** the store asked the person and nobody answered in time. Also never retried automatically.

## Log

Every grant event, approval, use, refusal and revocation is appended to the action log ([history.md](history.md)), signed by the **broker's** key. `grant.used` entries for browser ops carry `mode`, `login_mode` (`broker_filled` or `operator_filled`) where a login happened, and `conforming`.

## Credentials by site

`credential: { domain }` asks for "the person's login for this site".

- **Matching.** The store matches the domain against each login's saved URLs, the way a password manager matches a page: same registrable domain, so `www.opentable.com` and `opentable.com` both match `opentable.com`.
- **One item per grant.** If several logins match, `username` picks one. Without `username`:
  - a store that can list matches without fetching them refuses with `credential_ambiguous` and lists the usernames (no secrets). The core asks the person which one.
  - a store that can't list them leaves the choice to its own prompt.
- **The grant binds to the item, not the domain.** Once known, `credential_ref` is fixed for the grant's life. A later fetch that returns a different item is refused with `constraint_mismatch`.
- **The origin is the domain.** Browser calls under the grant are held to that site (`origin_mismatch` otherwise), and `fill_login` fills only there.
- The secret still goes only to the browser worker's `fill_login`, never to the core.

## Stores that ask the person themselves

Some stores ask the person before releasing anything. Bitwarden Agent Access, for one, shows a prompt on the person's computer for each request. That's a second approval on top of the grant's passkey.

- **The store reports how it approves:** `approval: "none" | "device_local" | "remote"`.
  - `none`: releases on the broker's request (a fixture, a service account).
  - `device_local`: asks on one device, typically a terminal or desktop prompt on the person's computer.
  - `remote`: can reach the person anywhere, for example a phone notification.
- **A `device_local` store needs the person at that device.** `grant.request` for a credential in such a store is refused with `store_needs_operator` unless `operator_present: true`. Errands the person isn't watching (a booking from the phone, anything scheduled) need a store with `none` or `remote` approval.
- **The grant is the binding limit.** The broker asks the store only while the grant is live. A store's own approval cache (Agent Access offers 10 minutes for one domain) never extends what the grant allows. When the grant ends, the broker stops asking.
- **Only one approval is ever binding: the passkey on the grant.** The store's prompt is an extra check by the person's vault. Making the two into one tap is open for 0.4.

## Store seam (internal)

The broker reads secrets through one interface:

```
CredentialStore.get(ref)            -> { record, secret }
CredentialStore.find({ domain })    -> [ { ref, record } ]     // optional
CredentialStore.fetch({ domain, username? }) -> { record, secret }  // for stores that can't list
CredentialStore.approval            -> "none" | "device_local" | "remote"
```

- `secret` is wrapped so it can't be printed or serialised by accident. `record` has no secret in it: name or item id, username, saved URLs, whether a TOTP exists.
- A store implements `find`, or `fetch`, or both. `find` lets the broker name the item on the approval page before fetching it. `fetch` stores name the item in their own prompt.
- **Failure results:**
  - `not_found`: the item isn't there, or the person refused it on the store's prompt.
  - `no_answer`: the person didn't answer the store's prompt in time.
  - `unavailable`: the store or its provider can't be reached.

  The broker maps these to `credential_not_found`, `store_no_answer` and `store_unavailable`.
- **Store client state belongs to the broker alone.** Pairing keys, session caches and tokens the store keeps live under the broker's own user, mode `0600` files in a `0700` directory. The broker refuses to start if they're readable by anyone else.
- **Implementations:**
  - `FixtureCredentialStore` (tests)
  - `AgentAccessStore`: Bitwarden or Vaultwarden through `aac`, `fetch` only, `device_local`. The vault stays unlocked only on the person's computer.
  - a `bw serve` store with a service account: `get` and `find`, `none`. This is the fallback.

  Another vault is another implementation of this interface.

## Fixture

A broker fixture that approves grants automatically, uses a fixture store with fake values, signs with a throwaway key, listens on one socket per caller, and proxies to a fake MCP server and a static fake site. Since 0.3 its store also answers `find` and `fetch` by domain, and can act as a `device_local` store that refuses or doesn't answer, so tests cover credentials by site, `store_needs_operator`, refusal without retry, and code delivery.
