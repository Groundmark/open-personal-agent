# Contracts changelog

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

- **How long a login approval lasts.** Standing grants cap at 7 days. Shipped agents let one approval cover a site for 30 days. Should `login`-only grants be allowed 30?
- **One tap, not two.** With a vault that prompts on its own, the person approves twice: the passkey on the grant, then the vault's prompt. Merge them, or let the passkey stand in for the vault's prompt?
- **Background errands with a personal vault.** A `device_local` store can't serve them. The options are a phone approval in front of the vault (our own provider), or a narrow service-account store (`bw serve`) for a chosen set of logins.
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
