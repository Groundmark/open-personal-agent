# History

Reads the agent's three logs ([contract](../../contracts/history.md)) with every other part stopped.

**Status:** working. No runtime dependencies (Node 22 built-ins only).

```
history [--dir <dir>] [--keys <keys.json>] [--json] verify | show <errand_id> | errands | pairing
```

- `verify`: checks every line of `actions.jsonl`, `context-reads.jsonl` and `conversation.jsonl`: `seq`, the `prev_hash` chain over each line's bytes, the type, and the broker's and context gateway's Ed25519 signatures (RFC 8785 canonical JSON, same code as the broker). It also fails a line that holds a secret-looking field (`password`, `code`, `otp`, `token`, …), since the contract says secrets and one-time codes never appear. It reports the first break in each log, and exits 1 if any log is broken. A signed log with no key to check it fails rather than passing unchecked.
- `show <errand_id>`: one errand as a story, merged by time across the three logs.
- `errands`: one line per errand: start, channels, outcome (the binding act and its confirmation, a refusal, or the person declining).
- `pairing`: pairing events, which belong to no errand.

`<dir>` defaults to `$OPA_HISTORY_DIR`, then the current directory. `keys.json` maps `broker` and `context` to public keys, PEM or JWK; default `<dir>/keys.json`.

```
npm test   # 9 tests: tampering of each kind, keys, leaks, the CLI, and the fixture errand's real logs
```

## What the logs do and don't protect against

The logs are the person's own record of what their agent did, read and said. `verify` catches accidents (a damaged file, an interrupted write) and edits by a part that doesn't own a log: each log is written by one part, as its own Unix user, and the broker's and context gateway's lines are signed. Binding acts are in the broker-signed action log, and they need the person's passkey anyway.

They are not proof against whoever controls the machine: lines cut from a log's end can't be detected, and the unsigned conversation log can be rewritten with a recomputed chain. For a personal agent on the person's own machine that's fine, since the records are theirs. It would matter for a host running agents for many people, who might want proof the host didn't edit their history; a short receipt sent to the person at the end of each errand would cover that.
