# History contract (logs)

**0.2-draft.** What the agent did, what it read and what was said: three append-only logs, kept separate, joined by `errand_id`. All three are readable with every part stopped.

## The three logs

| Log | Written by | One line per |
|---|---|---|
| `actions.jsonl` | broker | grant requested / approved / denied / used / refused / revoked / expired; identity declaration produced |
| `context-reads.jsonl` | context gateway | read |
| `conversation.jsonl` | core | message in or out |

Every line has `seq` (monotonic per log), `ts`, `errand_id`, `type` and `prev_hash` (SHA-256 of the previous line). Lines in `actions.jsonl` and `context-reads.jsonl` also carry `sig`: an Ed25519 signature by the writer's key over the line with `sig` removed, in canonical JSON (RFC 8785).

### `actions.jsonl` types

`grant.requested`, `grant.approved` (includes the passkey credential id and the bound hash), `grant.denied`, `grant.used` (op, a summary of the arguments, the result status, and for browser ops `mode`, `login_mode` and `conforming`), `grant.refused` (error code), `grant.revoked`, `grant.expired`, `browser.closed_on_grant_end`, `identity.declaration` (the declaration and `presented: true|false`).

### `conversation.jsonl`

`{ seq, ts, errand_id, type: "message", direction: "in" | "out", channel, message_id, text, attachments }`

Pairing events ([channel.md](channel.md#tracking-pairing-for-the-person)) go here too: `{ seq, ts, errand_id: null, type: "pairing", channel, event, old_key?, new_key? }`.

## Tools (`parts/history`)

- `history show <errand_id>`: merges the three logs by time into one readable story.
- `history verify`: checks every signature and hash chain offline, reports the first break.
- `history errands`: lists errands with start time, outcome and the channels used.

## Rules

- **Granularity.** Under a standing grant, `grant.used` is written once per `browser.open`, `browser.extract`, login and binding act, not for every click or scroll. Binding acts are always logged one by one.

- Append only. A correction is a new line that refers to the old one.
- Secrets never appear. Argument summaries are written by the broker, which knows what's secret.
- The log files live on the person's own machine, under their control, in plain JSONL.

## Fixture

A fixture errand's three logs, with a test that `verify` passes, and a tampered copy that `verify` must reject.
