# Provenance

These modules come from an earlier, private demo of a personal credential broker (October 2026, built for a live conference demo). The owner relicensed them under Apache-2.0 for this project. Only the reusable modules came across, not the demo's history.

The demo's code went through two independent security reviews. Comments that point to them now say "an earlier security review". The reviews themselves aren't public.

## What came across

| Path | Status | What it is |
|---|---|---|
| `src/jcs.js` | **ready** | RFC 8785 canonical JSON |
| `src/log.js` | **ready** | Signed, hash-chained JSONL log |
| `src/identity.js` | **ready** | The broker's Ed25519 identity key, made on first run |
| `src/credential-store.js` | **ready** | The `CredentialStore` seam and a fixture store; `Secret` can't be printed |
| `src/socket.js` | **ready** | One-JSON-line-per-connection Unix socket server |
| `src/fsutil.js` | **ready** | Atomic file writes |
| `approval/binding.js` | **ready** | Binds a passkey assertion to one grant: the challenge is the hash of the grant's creation body |
| `approval/passkeys.js` | **ready** | Store of registered passkeys (public keys only) |
| `test/` | **ready** | The carried-over unit tests, plus a software authenticator for WebAuthn tests |
| `from-demo/grants.js` | **reference, generalize** | Grant store and lifecycle. Built around one op (`solid.release` on data items) |
| `from-demo/approval.js` | **reference, generalize** | Approval hook interface and the simulated (auto) approval |
| `from-demo/server.js`, `from-demo/page/` | **reference, generalize** | The passkey approval page and enrollment server. Shaped for the demo's data release |

"Reference" means the logic is sound and reviewed, but it's shaped for the demo. It isn't wired into anything and has no tests here. Generalizing it to [`contracts/broker.md`](../../contracts/broker.md) is the broker work package.

## What didn't come across

The demo's data-release adapter, delivery receipts, scenario runner, console, enrollment scripts, live tests and test accounts. All of it was specific to the demo.

## Changes made while lifting

- Personal names, hostnames and private network addresses replaced with neutral values or configuration (`BROKER_REMOTE_ORIGIN`).
- References to the private design spec and review findings removed or made generic.
- `writeAtomic` moved from the grant store into `src/fsutil.js`, so the passkey store doesn't depend on demo code.
- Imports rewired to this layout.
