# Browser worker contract

**0.1-draft.** Drives websites for services with no API. It sits **on the broker's side of the seam**, because session cookies and passwords are credentials. The core reaches it only through the broker, which checks the grant first.

It may run on another machine than the broker (for example, driving the person's own browser on their laptop). In that case the broker reaches it over an authenticated, encrypted tunnel, and every call carries the broker's signature. The worker refuses calls not signed by its configured broker key.

## Operations

All take `grant_id`, which the broker has already checked and passes through for logging.

| op | args | result |
|---|---|---|
| `browser.open` | `{ grant_id, url }` | `{ session_id, page }` |
| `browser.act` | `{ grant_id, session_id, action, target, value?, book_grant_id? }` | `{ page }` |
| `browser.fill_login` | `{ grant_id, session_id, credential }` | `{ filled: <number of fields> }` |
| `browser.close` | `{ grant_id, session_id }` | `{}` |

- `action` is one of `click`, `type`, `select`, `scroll`, `wait`.
- `target` is a visible label, a role and name, or a CSS selector, in that order of preference.
- `page` is `{ url, title, text, screenshot_png_b64 }`, with every field that was filled from the store masked in both the text and the screenshot.

## Rules

- **`fill_login` is bound to the origin.** It's refused unless the page's origin matches the credential's recorded origin.
- **`type` refuses values that match any secret** the store holds for the grant's credential.
- **The binding click** (the final "complete reservation" or "pay" button) needs `book_grant_id`: an approved one-shot grant whose constraints match what the page shows (venue, date, time, party size). Mismatch → `constraint_mismatch`. The site's own confirmation page is captured into the action log.
- **Honest automation:** no stealth plugins, no faked fingerprints, no hiding automation flags. A deployment that drives the person's own browser records that mode (`"mode": "operator_browser"`) in every log entry, and the core logs the would-be declaration (`identity.declaration`) next to the act.

## Errors

`session_not_found`, `navigation_failed`, `blocked_by_site`, `target_not_found`, `origin_mismatch`, `secret_value_refused`, `constraint_mismatch`, `unauthorized_caller`, plus the common errors.

`blocked_by_site` is a finding, not a bug: record the status code and the page title.

## Fixture

A static look-alike booking site (search, time slots, login, confirm, done), served locally, plus a worker fixture that drives it with a real headless browser.
