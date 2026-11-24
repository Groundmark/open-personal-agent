# Fixtures

Stand-ins for every part, per [contracts v0.2-draft](../contracts/). They need no network, no account and no secret. A part is done when the fixture errand still passes with that part in place of its fixture.

```
npm ci
npm run errand   # books a table end to end and prints the conversation and the history
npm test         # the errand plus the refusals each contract promises (36 tests)
```

Needs Node 22+. The only dependencies are the schema validator (`ajv`, `ajv-formats`), pinned.

| Fixture | Contract | What it does |
|---|---|---|
| `site/` | (a relying party) | A plain-HTML look-alike site. Booking pages: search, slots, sign-in, confirm, done. An account page with a standing order: items, +/− buttons, an auto-checkout banner. `blockAutomation: true` makes it refuse self-declared automation past the home page |
| `store/` | broker.md: CredentialStore | Fake credentials, wrapped so they can't be printed |
| `broker/` | broker.md | Real grant rules (credential or operator-session grants, `read`, one-shot binding ops, exact constraints, consumption, origin, refusals), signed action log, agent and broker keys, one socket per caller. Approvals happen automatically, standing in for the passkey. Fronts a fake reservations MCP server |
| `browser-worker/` | browser-worker.md | A small HTTP "browser" for plain-HTML sites. Origin-bound login, masked secrets, read-only sessions, `extract`, `notices`, `await_login` with `operatorSignIn()` standing in for the person, the binding click gated on a matching one-shot grant. Honest user agent |
| `router/` | router.md | `POST /infer`, scripted replies |
| `channel/` | channel.md | Terminal channel with pairing: one-time code, pinned account id and identity key |
| `context/` | context-gateway.md | Fake items, tag scopes, a denylist that must never leak, logged reads |
| `history/` | history.md | `show`, `verify`, `errands` over the three logs |
| `errand/run.js` | core.md | A stand-in core running the booking errand, checking every request and response against `contracts/schemas/` |

## Swapping in a real part

Set an environment variable and the errand uses the real part instead of its fixture:

| Variable | Part |
|---|---|
| `OPA_ROUTER_URL` | `parts/router`: e.g. `http://127.0.0.1:8411/infer` |
| `OPA_BROKER_MODULE` | `parts/broker`: the path to `parts/broker/src/broker.js`. The fixture store, browser worker and MCP server are plugged into it, and approvals stand in for the passkey |

The fake restaurant's confirmation numbers are derived from the booking, not random, so the same errand gives the same pages every run and a recorded model run replays exactly.

## Not covered yet

- **A real-browser worker fixture** (Playwright against `site/`). The HTTP worker covers the contract, not JavaScript-heavy sites.
- **A real MCP wire fixture.** `FAKE_MCP` is in-process; a fixture speaking the MCP protocol is still to come.
- **Socket ownership.** The fixture runs as one Unix user, so it proves the caller by socket path and the `caller` field only. A real broker gives each socket to its caller's user (`0600`) and may check `SO_PEERCRED`.
- **`standing_order_origins` and `edit_order` in the worker.** The read-only refusal is covered. A non-read-only session on a standing-order site doesn't yet demand an `edit_order` grant.

## Contract questions settled in 0.2

1. **Caller proof** was circular (the broker held the key it verified). It's now one socket per caller ([broker.md](../contracts/broker.md#caller-proof)).
2. **Standing-grant logging granularity** is now stated in history.md.
