# Fixtures

Stand-ins for every part, per [contracts v0.1-draft](../contracts/). They need no network, no account and no secret. A part is done when the fixture errand still passes with that part in place of its fixture.

```
npm ci
npm run errand   # books a table end to end and prints the conversation and the history
npm test         # the errand plus the refusals each contract promises (13 tests)
```

Needs Node 22+. The only dependencies are the schema validator (`ajv`, `ajv-formats`), pinned.

| Fixture | Contract | What it does |
|---|---|---|
| `site/` | (a relying party) | A plain-HTML look-alike booking site: search, slots, sign-in, confirm, done. `blockAutomation: true` makes it refuse self-declared automation past the home page |
| `store/` | broker.md: CredentialStore | Fake credentials, wrapped so they can't be printed |
| `broker/` | broker.md | Real grant rules (one-shot booking, exact constraints, consumption, refusals), signed action log, agent and broker keys. Approvals happen automatically, standing in for the passkey. Fronts a fake reservations MCP server |
| `browser-worker/` | browser-worker.md | A small HTTP "browser" for plain-HTML sites. Origin-bound login, masked secrets, the binding click gated on a matching one-shot grant. Honest user agent |
| `router/` | router.md | `POST /infer`, scripted replies |
| `channel/` | channel.md | Terminal channel with an allowlist |
| `context/` | context-gateway.md | Fake items, tag scopes, a denylist that must never leak, logged reads |
| `history/` | history.md | `show`, `verify`, `errands` over the three logs |
| `errand/run.js` | core.md | A stand-in core running the booking errand, checking every request and response against `contracts/schemas/` |

## Not covered yet

- **A real-browser worker fixture** (Playwright against `site/`). The HTTP worker covers the contract, not JavaScript-heavy sites.
- **A real MCP wire fixture.** `FAKE_MCP` is in-process; a fixture speaking the MCP protocol is still to come.
- **Caller proof.** Not implemented, because of an open contract question (below).

## Open contract questions found while building these

1. **Caller proof is circular.** broker.md has the core sign broker requests with the agent key, but the broker holds that key and signs on request. So proof of caller rests on who may reach the broker's socket. For 0.2: either the core holds its own key, or the broker checks the peer's Unix credentials (`SO_PEERCRED`) and drops `sig`.
2. **Standing-grant use is logged per page open, not per action.** That's fine for search, but say so in history.md.
