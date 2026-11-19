# Contracts changelog

## 0.1-draft, 2026-11-19

First draft of all seven contracts: envelope, broker (with identity), browser worker, router, channel, context gateway, history, core. JSON Schemas are in `schemas/`. Open for comment; nothing is built against these yet.

### Open for 0.2 (found while building the fixtures)

- Caller proof is circular as written (the broker holds the agent key it would verify). Options: the core holds its own key, or use Unix peer credentials. See `fixtures/README.md`.
