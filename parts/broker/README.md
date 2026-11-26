# Broker

The credential broker: it holds the person's secrets and acts on them under grants the person approves with a passkey. The agent never sees a raw secret. Contract: [`contracts/broker.md`](../../contracts/broker.md).

**Status:** the broker core works: every operation in contracts 0.4, grants that survive a restart, the contract's signed action log, one socket per caller. All 27 fixture tests and the fixture errand pass with it swapped in (`OPA_BROKER_MODULE=<path to src/broker.js> npm test` in `fixtures/`). Stores (`src/bw-store.js`, `src/agent-access-store.js`), chosen in `broker.json` (`vault`):
- **Bitwarden service account** (`BitwardenStore`, approval `none`): a narrow account that sees one collection, for errands the person isn't watching. It runs the `bw` CLI per request rather than `bw serve`, because bw serve's REST API on loopback has no authentication and every local user (the core included) could read the vault through it. The account is unlocked once at start from systemd credentials (`bw-client-id`, `bw-client-secret`, `bw-password`). The session key stays in the broker's memory and goes to each `bw` command in its environment, never on the command line or disk; the account's encrypted data is in the broker's `0700` directory. So only the broker's user and root can read the vault, and it stays unlocked until the broker stops. Items outside the collection are treated as missing.
- **Bitwarden Agent Access** (`AgentAccessStore`, approval `device_local`): asks the person on their computer; usable only with `operator_present`.
- Login-free **web services** (`web_services`, e.g. the demo restaurant) sit beside either: their "credential" is the service's name with no secret, and they never need the person at their computer.
- `src/groundmark-http.js`: requests to those relying parties, signed as the agent (RFC 9421, Ed25519; the key at `_agentid.<agent domain>`), signed again with the relying party's nonce when it asks. Only binding tools may use a method other than `GET`. For a binding grant the broker fixes the exact request (tool, method, URL, body digest) when it creates the grant; the passkey approves it, the approval page shows it ("Sends") with every argument, and `mcp.call` sends only that request. A binding grant with no recorded request is refused, and arguments never replace a query parameter fixed in the configured path.

- `approval/server.js`: the passkey approval page (from the demo's, generalised). A grant's link shows the summary, what the agent may do, with what, for how long and why; approving signs the grant's hash with the person's passkey (user verification required), checked by `@simplewebauthn/server` and again by `approval/binding.js`. Declining needs no passkey. Nothing lists grants, since the page is public behind a tunnel. A passkey is set up with a one-time link from `opa-broker enroll` (15 minutes, one passkey); registrations go to `admin.jsonl`, signed.
- `src/main.js`: `opa-broker serve <broker.json>` and `opa-broker enroll <broker.json>`.

- `src/broker.js`: the operations, with the store, browser worker, MCP servers and approvals plugged in.
- `src/grants.js`: request checks, the lifecycle, and the grant store (`grants.json`, no secrets in it).
- `src/actions-log.js`: `actions.jsonl` in the contract's format, signed with the broker key; `parts/history` verifies it.
- `src/sockets.js`: one socket per caller. Deployed, systemd makes each socket (`SocketUser=` the caller, `SocketMode=0600`, `FileDescriptorName=` the caller) and hands it over, so only that caller can connect and the broker needs no root. A channel adapter's socket serves only `code.slots`, `code.deliver` and `status`.
- Two keys in the state directory: `broker.key` signs the log, `agent.key` signs declarations and requests to relying parties. There's no `identity.sign`: the broker builds and signs each declaration itself (`identity.declaration`), only for an act an approved grant covers, so the core can't get anything signed that the person didn't approve.
- The broker refuses browser calls on a session it didn't open, and checks the session is on the grant's site, before it asks a vault or opens a code slot.


**Stores:**
- `src/credential-store.js`: the seam, plus a fixture store.
- `src/agent-access-store.js` (new in 0.3, not from the demo): the person's Bitwarden or Vaultwarden through Bitwarden Agent Access (`aac`). It is fetch-only and `device_local`: the person approves each request on their computer. The exit-code mapping follows `aac` v0.11.0 as observed in a live test. The store refuses to run if `aac`'s state is readable by anyone but the broker.

```
npm test   # 59 tests: the Bitwarden store against a fake bw, the approval flow with a software passkey, the broker core, plus canonical JSON, identity, credential stores, atomic writes
```
