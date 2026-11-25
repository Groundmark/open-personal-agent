# Contracts changelog

## 0.4-draft, 2026-11-24

From building every part except the browser worker and context gateway against 0.3, and running the agent end to end: a booking at a demo restaurant that verifies the agent's Groundmark signature, approved with a passkey from a phone.

### Broker

- **The broker signs only what the person approved, and the approval covers the exact request.**
  - **`identity.sign` is gone (breaking).** A relying party takes what the agent's key signs as the agent's own act. If the core could get any request signed, a compromised core could book or buy with no grant; if it could get any declaration signed, it could claim "the agent did X" for something nobody approved. The broker now signs only what it builds itself, under a grant.
  - **`identity.declaration` needs an approved act (breaking).** args are now `{ grant_id, act }`. The grant must be approved, unexpired and not revoked, and `act` one of its ops; a one-shot grant also qualifies once spent on that act, until it would have expired. The broker takes the relying party and the constraints from the grant, not from the caller, and checks the grant just before it signs.
  - **A spent one-shot grant can be revoked,** which stops declarations of its act. A grant revoked while a call is in flight stays revoked.
  - **Relying parties that verify the agent** (new section). The broker calls them itself over HTTPS and signs each request as the agent (RFC 9421, the key at `_agentid.<agent domain>`). The core reaches them with `mcp.call`, like an MCP server. Under a standing grant the broker signs only `GET`s, for `read` and `search`. A broker refuses to start with any other method configured for a non-binding tool.
  - **Exact request.** For a binding op made by a tool, the broker fixes the one call the grant allows when it creates the grant: server and tool, and for a relying party the method, URL and body digest (the body is the arguments as canonical JSON). The passkey approves it with the rest of the grant, and the approval page shows all of it: every constraint, and the call. At use, `mcp.call` must be that call, and the request the broker would send must still equal it (`constraint_mismatch` otherwise). This catches a configuration that changed between approval and use. A binding grant with no exact request can't be used for a binding tool.
  - **Reads stay reads.** A relying party's arguments can't replace query parameters fixed in its configured path, and the contract says `GET` alone isn't enough: read tools must point at endpoints that stay read-only for any arguments.
  - New `grant.request` arg `call: { server, tool }`, needed only when more than one tool could make the act. `grant.request` and `grant.status` return the exact request as `request`.
  - **The passkey covers everything the approval page shows,** now spelled out: `ttl_seconds`, `purpose`, `operator_present`, the login item once known, and the summary, as well as the credential, ops, constraints, mode and exact request.
- **An unknown outcome spends a one-shot grant.** Only a definite refusal (for HTTP, a 4xx other than 408 and 429) gives it back. After a timeout, a lost connection or a 5xx the core tells the person it couldn't confirm the outcome, and never retries on its own.
- **`code.slots`** (channel adapters' sockets only): how an adapter learns a code slot opened. 0.3 had the broker tell the adapter, but the adapter is always the caller on its socket, so the broker couldn't start that conversation. The adapter long-polls: `code.slots { wait_seconds, cursor }` → `{ slots: [{ slot_id, expires_at, account_id? }], cursor }`.
  - **A cursor,** so the adapter hears of each slot once instead of getting the same open slot back on every poll. It's opaque, and survives slots closing; one from before a broker restart lists every open slot.
  - **One adapter per slot.** `browser.fill_code` with `source: "person"` takes `channel`, the adapter the person is talking on (required when the broker serves more than one). Only that adapter is told of the slot or can fill it.
  - `wait_seconds` outside 0 to 60 is refused (`bad_request`), not clamped.
  - **A slot ends with its grant** (revoked, expired, or its session closed), and the broker checks the grant and session again before filling a code.
  - A channel adapter's socket serves only `code.slots`, `code.deliver` and `status` (now said in the contract).
  - The schema's `code_slot.opened` becomes `code_slot`.
- **The Bitwarden service-account store runs the `bw` command once per request, never `bw serve`.** `bw serve`'s local API has no authentication, so any program on the machine, the core included, could read the vault through it. The contract now says where the unlocked vault lives and who can read it:
  - the session key in the broker's memory only, handed to each `bw` command in its environment;
  - the account's encrypted data in the broker's `0700` directory;
  - the password and API key read at start from files only the broker can read.

  So the broker's own user and root can read it, and no other part can. The trade-off: it stays unlocked until the broker stops.

### Channel

- **One-time codes:** the adapter learns of a slot with `code.slots`, passing back the cursor it was last given. It's told only of slots opened for its own channel.
- **The account belongs to the agent.** For Signal, that's a number of the agent's own (a cheap VoIP number only the agent uses), not a second phone for the person. The agent keeps it when it moves to another provider.

### Fixtures

- The broker fixture follows every 0.4 rule above:
  - `code.slots` with a cursor and per-channel slots, and the terminal channel fixture long-polls it (the errand runs through it end to end);
  - `identity.declaration` checks the grant;
  - an unknown outcome spends a one-shot grant;
  - the exact call of a binding grant (`call`), with every argument compared;
  - a summary that names the call and every constraint, and a grant hash over everything shown;
  - `code.deliver` refuses anything but 4 to 10 letters and digits, and leaves the slot open;
  - one-shot grants are reserved before any asynchronous work, so two concurrent calls can't both use one;
  - a channel adapter's socket is refused everything but `code.slots`, `code.deliver` and `status`.
- New tests: `code.slots` (each slot heard of once; only the right adapter; refused on the core's socket; bad `wait_seconds`), `identity.declaration` (refused without an approved act; allowed after the act), the unknown-outcome rule (a failed booking can't be retried; a definite refusal can), a binding call that adds an argument nobody approved, and the summary and hash.

### Background errands with a personal vault: decided in 0.3, changed here

0.3 decided on a narrow `bw serve` account for recurring errands. It's now the same narrow service account, reached through the `bw` command per request. The questions to settle before building recurring errands stay open: what may go in the collection, and whether checkout on a recurring errand needs a fresh one-shot grant.

### Still open

The rest of 0.3's list: one tap instead of two with a vault that prompts on its own; sign-in links sent by email; and from 0.2, read-only enforcement in `operator_browser` mode, a Playwright worker fixture and an MCP wire fixture, and which op a non-final, state-changing click on an ordinary site needs.

## 0.3-draft, 2026-11-23

From a live test of fetching a login from the person's own password manager (Bitwarden Agent Access against a self-hosted Vaultwarden, dummy items only), and from comparing how shipped personal agents handle logins.

### Broker

- **Credentials by site.** `credential` may be `{ domain, username? }`: "my login for this site", with nothing registered first.
  - The store matches the domain the way a password manager matches a page.
  - Several matches give `credential_ambiguous`, with the usernames in the error's `detail`.
  - The grant binds to the item it finds (`credential_ref`), and browsing is held to that site.
- **Stores that ask the person themselves.**
  - A store reports `approval: none | device_local | remote`.
  - A `device_local` store (one that prompts on the person's computer) can only be used with `operator_present: true`. Otherwise the broker refuses with `store_needs_operator`.
  - The grant stays the binding limit: a store's own approval cache never extends it.
- **Failures a person's vault can give:**
  - `credential_not_found`: absent, or refused on the vault's prompt. Some vaults can't tell these apart.
  - `store_no_answer`: nobody answered the prompt.
  - `store_unavailable`: the vault can't be reached.

  Never retried automatically.
- **One-time codes:** `browser.fill_code` with `source: store_totp | person`.
  - A code from the person goes through a **code slot**: the channel adapter hands it to the broker with `code.deliver`. That op is only on adapters' sockets, so the core and the model never see the code.
  - New error: `code_timeout`.
- **Store seam:** `find` (list matches without fetching) and `fetch` (stores that only release one login per request) join `get`.
  - The store's client state (pairing keys, caches) must be the broker's alone: `0600` in a `0700` directory.
  - **New in `parts/broker`:** `AgentAccessStore`.

### Browser worker

- `browser.fill_code`: origin-bound and masked like `fill_login`.
- `fill_login` takes no `credential` under a credential-by-site grant.

### Channel

- **One-time codes:** while a slot is open, a message that is only a code goes to the broker, and the core gets `[one-time code delivered]`.

### Core and history

- **Core:**
  - new tools `sign_in_with_saved_login` and `enter_code`
  - rules: codes are never the model's; a refused login is final for the errand; set `operator_present` only when the person said they're at the computer
- **History:**
  - codes never appear in any log
  - logins from a store that asks the person record `store_approval` and the outcome

### Envelope

- An error response may carry `detail` (an object, never a secret) where a contract says so.

### Fixtures

- 25 tests (7 new): credentials by site, ambiguity, `store_needs_operator`, refusal without retry, `store_no_answer`, a stored TOTP, and a code from the person through the channel.
- `parts/broker` has 21 tests, 3 of them new for `AgentAccessStore` against a fake `aac`: exit codes, no secret in errors, and it refuses world-readable state.

### Still open for 0.4

- **How long a login approval lasts. Decided: stay at 7 days.** Standing grants, `login`-only included, keep the 7-day cap while the project is scaling up. Shipped agents allow 30 days per site; revisit once there's a track record.
- **One tap, not two. Goal: one tap.** With a vault that prompts on its own, the person approves twice: the passkey on the grant, then the vault's prompt. One tap is the target. For now:
  - stores with `approval: none` (the `bw serve` store below) already need only the passkey;
  - `device_local` stores (Agent Access) keep both taps until there's a provider that can take the broker's approval as its own.
- **Background errands with a personal vault. Decided: a narrow `bw serve` store for recurring errands.** A `device_local` store can't serve them. Recurring errands the person sets up in advance (a weekly shopping order, say) get logins from a separate `bw serve` account that can see only a chosen collection. Agent Access stays the route for one-off sign-ins with the person at the computer. To settle before building it:
  - what may go in the collection (logins only; no payment cards, no email or bank logins);
  - whether checkout on a recurring errand still needs a fresh one-shot grant.
- **Sign-in links** sent by email: like codes, but they're links. Does the same slot carry them?
- From 0.2: read-only enforcement in `operator_browser` mode; a Playwright worker fixture and an MCP wire fixture; which op a non-final, state-changing click on an ordinary site needs.

## 0.2-draft, 2026-11-23

From the first live errand: a read-only spike against a real grocery subscription site. The person texted the agent on Signal, signed in themselves in their own Chrome, the agent read the upcoming order through the browser, and replied over Signal. These changes are what that errand showed the contracts were missing.

### Broker

- **Caller proof, fixed (breaking).** It now uses one socket per caller: the socket a request arrives on is the caller, and `SO_PEERCRED` is an optional second check. `identity.sign` no longer offers `caller_proof`. The envelope's `sig` is now for calls that cross machines.
  - **How only the caller can open its socket is up to the deployment:** separate Unix users, systemd `DynamicUser=`, or a container per part.
  - **A host running many agents isolates each person first.** Separating parts within one agent is the second layer.
- **Operator sessions.** A grant names either a `credential` or a `session: { origin, browser: "operator" }`: a site the person is signed in to in their own browser, for which the broker holds no secret.
- **New ops.**
  - `read`: the person's own account data, standing-grant eligible. A grant allowing only `read` forces read-only browser sessions.
  - `edit_order`: binding, one-shot, with `constraints.changes`.
  - `ops` is now a closed list: `read`, `search`, `login`, `book`, `edit_order`, `pay`.
- **Browser calls are held to the grant's origin** (`origin_mismatch`, a new error). Sessions are closed when their grant ends.
- **Logging.** `grant.used` for browser ops records `mode`, `login_mode` and `conforming`.

### Browser worker

- **Two modes:** `agent_browser` and `operator_browser`. A worker that can't verify the broker's signature (for example, a general-purpose assistant extension) is non-conforming: it may be used for spikes, logged as such, and never performs a binding act.
- **`browser.await_login`:** the person signs in themselves and the secret never enters the agent's side. New error `login_timeout`.
- **`browser.open` takes `read_only`.** A read-only session refuses typing, selecting and form submits. New error `read_only_session`.
- **`browser.extract { target }`** returns one region (an order, a cart), not the whole page.
- **`page.notices`** carries banners and countdowns, because deadlines are often the answer.
- **Standing-order sites** (`standing_order_origins`): every edit is binding and needs an `edit_order` grant, because there's no final "pay" click to guard.

### Channel

- **Accounts, not phone numbers (breaking).**
  - `from` and `to` are the channel's stable account id. Signal hides phone numbers by default, so the person's message arrived with none.
  - `from_display` carries the self-chosen profile name, which never decides anything.
- **Pairing.** A one-time code shown at install pins one account id and its identity key. An identity-key change stops forwarding until re-paired. New error `not_paired`.
- **Pairing is tracked for the person.** Pairing events go into `conversation.jsonl` as `type: "pairing"`, and the adapter counts dropped messages. After a re-pair the agent says what was dropped. A multi-person host tells the person about `identity_changed` by another route.
- **One adapter owns the account.** For Signal, a second `receive` steals messages.

### Core and history

- **Core:**
  - new tools: `read_*`, `ask_to_sign_in` and `request_order_change`
  - deadlines from `notices` go in the reply as absolute times
  - the fixture errand gains a read errand
- **History:** says how often `grant.used` is written under a standing grant (once per open, extract, login and binding act). New action type `browser.closed_on_grant_end`.

### Still open for 0.3

- Read-only enforcement in `operator_browser` mode is best effort (the person's page can change under the worker). The `read` grant is the backstop. Is that enough?
- A real-browser worker fixture (Playwright) and an MCP wire fixture.
- Which grant op does a non-final but state-changing click on an ordinary site need (a newsletter checkbox, an address edit)?

## 0.1-draft, 2026-11-19

First draft of all seven contracts: envelope, broker (with identity), browser worker, router, channel, context gateway, history, core. JSON Schemas are in `schemas/`. Open for comment; nothing is built against these yet.

### Open for 0.2 (found while building the fixtures)

- Caller proof is circular as written (the broker holds the agent key it would verify). Options: the core holds its own key, or use Unix peer credentials. See `fixtures/README.md`.
