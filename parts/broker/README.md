# Broker

The credential broker: it holds the person's secrets and acts on them under grants the person approves with a passkey. The agent never sees a raw secret. Contract: [`contracts/broker.md`](../../contracts/broker.md).

**Status:** starting modules lifted from an earlier demo (see [PROVENANCE.md](PROVENANCE.md)). Not yet a running broker. Until it is, the fixture errand uses [`fixtures/broker/`](../../fixtures/broker/).

```
npm test   # 18 tests: canonical JSON, identity, credential store, atomic writes
```
