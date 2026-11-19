# Contracts

**Version 0.1-draft.** A contract is the written promise one part makes to the others: what you can ask it, what it answers, how it fails, and a fake version of itself you can test against. Build to the contract, never to another part's internals.

| Seam | Contract | Schema | Served by |
|---|---|---|---|
| Credentials, grants, identity | [broker.md](broker.md) | [schemas/broker.schema.json](schemas/broker.schema.json) | `parts/broker` |
| Driving websites | [browser-worker.md](browser-worker.md) | [schemas/browser-worker.schema.json](schemas/browser-worker.schema.json) | `parts/browser-worker` (via the broker) |
| Personal context | [context-gateway.md](context-gateway.md) | [schemas/context-gateway.schema.json](schemas/context-gateway.schema.json) | `parts/context-gateway` |
| Inference | [router.md](router.md) | [schemas/router.schema.json](schemas/router.schema.json) | `parts/router` |
| Front end | [channel.md](channel.md) | [schemas/channel.schema.json](schemas/channel.schema.json) | `parts/channel-*` |
| Logs and history | [history.md](history.md) | [schemas/history.schema.json](schemas/history.schema.json) | every part writes; `parts/history` reads |
| The loop | [core.md](core.md) | `grant.event` is in [schemas/channel.schema.json](schemas/channel.schema.json); otherwise uses the others | `parts/core` |

## Conventions every seam follows

### Transport

- **One JSON object per line** (UTF-8, `\n`-terminated) over a **Unix domain socket**. One request per connection: connect, write one line, read one line, close.
- Sockets live under a runtime directory set in each part's config. The socket file is mode `0660`, and its group is the set of parts allowed to call it.
- **Exceptions:**
  - The router speaks the same JSON over loopback HTTP (`POST /infer`), so off-the-shelf HTTP tooling works.
  - A part on another machine (for example, a browser worker on the operator's laptop) is reached through an authenticated tunnel the deployment provides. The contract doesn't change.

### The envelope

Every request:

```json
{ "op": "grant.request", "id": "01JD...", "caller": "core", "errand_id": "01JD...", "ts": "2026-11-19T18:04:05Z", "args": { } }
```

| Field | Meaning |
|---|---|
| `op` | The operation, `<area>.<verb>` |
| `id` | Request id, a ULID. Echoed in the response and written to logs |
| `caller` | Which part is calling: `core`, `broker`, `router`, `context-gateway`, `channel-<name>`, `browser-worker`, `history` |
| `errand_id` | A ULID minted by the core when an errand starts. Present on everything done for that errand. `null` only for housekeeping (`status`) |
| `ts` | RFC 3339 UTC time |
| `args` | Op-specific, defined in each contract |
| `sig` | Optional. A signature over the request, where a seam requires proof of caller (see [broker.md](broker.md#caller-proof)) |

Every response is one of:

```json
{ "id": "01JD...", "ok": true, "result": { } }
{ "id": "01JD...", "ok": false, "error": "grant_not_approved", "message": "Human-readable detail. Never contains a secret." }
```

- `error` is from a **closed list** in each contract.
- Every seam also allows these common errors: `bad_request` (doesn't match the schema), `unknown_op`, `unauthorized_caller`, `internal`.

### Rules

- **No secret ever crosses a seam,** except that a `CredentialStore` hands one to the broker internally. No field in any response carries a password, token, key or cookie.
- **Logs are append-only JSONL.** Nothing is deleted or rewritten.
- **Every part ships a fixture:** a stand-in that runs with no network, no account and no secret, and answers per its contract. A part is done when the end-to-end fixture errand passes against everyone else's fixtures.
- **Unknown fields are ignored, not rejected,** so minor versions can add fields. Removing or changing a field is a major version.

### Changing a contract

Contracts change by a dated entry in [CHANGELOG.md](CHANGELOG.md), in a PR of its own, approved by a maintainer. Don't change a contract inside a feature PR.
