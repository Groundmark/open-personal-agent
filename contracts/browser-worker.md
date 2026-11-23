# Browser worker contract

**0.2-draft.** Drives websites for services with no API. It sits **on the broker's side of the seam**, because session cookies and passwords are credentials. The core reaches it only through the broker, which checks the grant first.

It may run on another machine than the broker (for example, driving the person's own browser on their laptop). In that case the broker reaches it over an authenticated, encrypted tunnel, and every call carries the broker's signature. The worker refuses calls not signed by its configured broker key.

## Two browser modes

| `mode` | Whose browser | Who signs in |
|---|---|---|
| `agent_browser` | A browser the worker runs for the agent | The broker, with `browser.fill_login` |
| `operator_browser` | The person's own browser, in tabs the worker opens | Usually the person, with their own password manager; the worker waits with `browser.await_login` |

Every log entry records the mode.

**Conforming worker.** A conforming worker checks the broker's signature on every call. A general-purpose assistant extension driving the person's browser (for example Claude in Chrome) has no broker in its path, so it can't conform. It's fine for spikes. Its log entries say `"conforming": false`, and it never performs a binding act.

## Operations

All take `grant_id`, which the broker has already checked and passes through for logging.

| op | args | result |
|---|---|---|
| `browser.open` | `{ grant_id, url, read_only? }` | `{ session_id, page }` |
| `browser.act` | `{ grant_id, session_id, action, target, value?, book_grant_id? }` | `{ page }` |
| `browser.extract` | `{ grant_id, session_id, target }` | `{ page }`, covering only that region |
| `browser.fill_login` | `{ grant_id, session_id, credential }` | `{ filled: <number of fields> }` |
| `browser.await_login` | `{ grant_id, session_id, timeout_seconds }` | `{ logged_in: true, login_mode: "operator_filled" }` |
| `browser.close` | `{ grant_id, session_id }` | `{}` |

- `action` is one of `click`, `type`, `select`, `scroll`, `wait`.
- `target` is a visible label, a role and name, or a CSS selector, in that order of preference.
- `page` is `{ url, title, text, notices?, screenshot_png_b64? }`.
  - Every field that was filled from the store is masked in both the text and the screenshot.
  - `notices` holds the site's banners and countdowns: text the site shows apart from the main content, such as "Automatic checkout at 4pm on Mon, Nov 23" or "04:58:16 before this delivery locks". Deadlines are often the answer, so keep them.
- `browser.extract` exists because whole-page text on a shop is mostly promotions. Ask for the region that matters (a cart, an order, a reservation) and get only its text and screenshot.

## Signing in

- **`fill_login` is bound to the origin.** It's refused unless the page's origin matches the credential's recorded origin.
- **`await_login` is for the person signing in themselves.** The core tells them over the channel to sign in on the device that runs the browser. The worker then waits until the page shows a signed-in state, or until `timeout_seconds` passes (`login_timeout`). The secret never enters the agent's side, not even the broker. Use it when the person would rather fill from their own password manager, and whenever the broker holds no credential for the site.
- **`type` refuses values that match any secret** the store holds for the grant's credential.

## Read-only sessions

`browser.open` with `read_only: true` opens a session for reading. In it the worker:

- refuses `type` and `select`
- refuses any `click` that would submit a form or change state: buttons for add, remove, quantity, +, −, subscribe, skip, swap, cancel, save, checkout, pay, confirm, and any form submit
- allows links, tabs, disclosure buttons (a drawer, a menu, "View order"), `scroll` and `wait`

A refused action returns `read_only_session`. In an `operator_browser` session this check is best effort: the person's page can change under the worker. So a read errand should also be requested under a `read` grant (see [broker.md](broker.md)), which can't authorise a binding act.

## Binding acts

- **The binding click** (the final "complete reservation" or "pay" button) needs `book_grant_id`: an approved one-shot grant whose constraints match what the page shows (venue, date, time, party size). Mismatch → `constraint_mismatch`. The site's own confirmation page is captured into the action log.
- **Standing-order sites have no final click.** A grocery subscription, a recurring delivery or an auto-renewing cart checks out on a schedule, so **every edit is binding**: a quantity change, adding an item, skipping a week. The worker's config lists such origins under `standing_order_origins`. On those origins, any state-changing action needs a one-shot grant whose op is `edit_order`, with constraints that name the change (`{ item, quantity }`, or `{ skip: "<date>" }`).

## Sessions and grants

- **A session lives no longer than its grant.** When the grant expires or is revoked, the broker calls `browser.close` on every session opened under it. The worker refuses calls on a session whose grant is no longer live, whatever the browser's cookies still allow.
- **In `operator_browser` mode the worker touches only the tabs it opened.** It never reads or acts in the person's other tabs. Closing its tabs doesn't sign the person out: their sign-in is theirs.

## Honest automation

No stealth plugins, no faked fingerprints, no hiding automation flags. The worker records its mode in every log entry, and the core logs the would-be declaration (`identity.declaration`) next to the act.

## Errors

`session_not_found`, `navigation_failed`, `blocked_by_site`, `target_not_found`, `origin_mismatch`, `secret_value_refused`, `constraint_mismatch`, `read_only_session`, `login_timeout`, `unauthorized_caller`, plus the common errors.

`blocked_by_site` is a finding, not a bug: record the status code and the page title.

## Fixture

A static look-alike site, served locally: booking pages (search, time slots, login, confirm, done) and an account page with a standing order (items, +/− buttons, an auto-checkout banner). A worker fixture drives it over HTTP. `operatorSignIn(session_id)` stands in for the person signing in during `await_login`.
