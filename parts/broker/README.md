# Broker

The credential broker: it holds the person's secrets and acts on them under grants the person approves with a passkey. The agent never sees a raw secret. Contract: [`contracts/broker.md`](../../contracts/broker.md).

**Status:** starting modules lifted from an earlier demo (see [PROVENANCE.md](PROVENANCE.md)). Not yet a running broker. Until it is, the fixture errand uses [`fixtures/broker/`](../../fixtures/broker/).

**Stores:**
- `src/credential-store.js`: the seam, plus a fixture store.
- `src/agent-access-store.js` (new in 0.3, not from the demo): the person's Bitwarden or Vaultwarden through Bitwarden Agent Access (`aac`). It is fetch-only and `device_local`: the person approves each request on their computer. The exit-code mapping follows `aac` v0.11.0 as observed in a live test. The store refuses to run if `aac`'s state is readable by anyone but the broker.

```
npm test   # 21 tests: canonical JSON, identity, credential stores, atomic writes
```
