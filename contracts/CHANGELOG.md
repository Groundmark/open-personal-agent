# Contracts changelog

## 0.2-draft, 2026-11-23

From the first live errand: a read-only spike against a real grocery subscription site. The person texted the agent on Signal, signed in themselves in their own Chrome, the agent read the upcoming order through the browser, and replied over Signal. These changes are what that errand showed the contracts were missing.

### Broker

- **Caller proof, fixed (breaking).** It now uses one socket per caller: the socket a request arrives on is the caller, and `SO_PEERCRED` is an optional second check. `identity.sign` no longer offers `caller_proof`. The envelope's `sig` is now for calls that cross machines.
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
