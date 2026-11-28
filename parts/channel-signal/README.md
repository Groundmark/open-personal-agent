# Signal channel

The person texts the agent's own Signal number ([contract](../../contracts/channel.md), channel `signal`), and the agent can text them first.

**Status:** working against a test double of signal-cli; deployed once the agent has its own Signal number. No runtime dependencies besides signal-cli itself (0.14.10, the native Linux build: no Java).

- **One adapter owns the account:** signal-cli runs as the adapter's child, in JSON-RPC mode on stdin/stdout, the account's only receiver.
- **Pairing:** `opa-channel-signal pair <signal.json>` shows a six-digit code on the machine (15 minutes, once; only its hash is stored). The first message that is exactly the code pins the sender's account id (ACI) and identity key fingerprint, and the agent replies "Paired."
- **Only the paired account, with its pinned key, is forwarded.** Strangers and group messages are dropped, counted (`status`) and get no reply. `from_display` (the profile name) never decides anything.
- **A changed identity key** (new phone, reinstall, someone else) stops forwarding and logs `identity_changed`; `channel.send` answers `not_paired` until the person pairs again with a new code. The re-pair reply says how many messages from their account were dropped meanwhile. signal-cli runs with `--trust-new-identities on-first-use`, so it also refuses to *send* to a changed key: someone who took over the person's number, and never writes to the agent, still gets nothing.
- **Re-pairing after a key change:** stop the adapter, check the person's new safety number with them, trust it with the same account and config (`signal-cli --config <signal_cli_config> -a <account> trust -v <safety number> <their number>`), start the adapter again, and pair with a new code.
- **If signal-cli can't start or stops,** the adapter exits and systemd starts it again; calls to it time out after 30 s.
- **One-time codes:** the adapter waits on its own broker socket with `code.slots` (see below). While a slot is open, a message from the person that is only a code goes to the broker with `code.deliver`, and the core gets `[one-time code delivered]`. A code is 4 to 10 letters and digits once spaces (of any kind) and dashes are stripped, **with at least one digit**: narrower than contracts/channel.md, so that "ok thanks" sent while a code is awaited isn't taken as one (proposed for 0.5; a letters-only code goes to the core as text). The slot is kept until the broker says it's filled or gone, so after a hiccup the person can just send the code again. Codes are never written to disk or the adapter's log.
- **No history kept.** The core owns the conversation.

## Contract notes

- **`code.slots`** (in contracts 0.4): the adapter long-polls its broker socket to learn that a code slot opened, since the broker can't start a conversation on a socket where the adapter is the caller. It passes back the cursor each answer gives, so it hears of each slot once, and it's told only of slots opened for the Signal channel.
- **The number is the agent's own** (contracts 0.4): a cheap VoIP number only the agent uses is enough, and the agent keeps it if it moves to another provider.
- **Still open: pairing events in `conversation.jsonl`.** The core writes that log, not the adapter, so for now pairing events go to the adapter's own log (the journal). An op for adapters to hand the core a pairing event would close the gap.

```
npm test   # 12 tests: pairing (and its refusals, and waiting for a key), strangers and groups, a changed identity key (on receive and on send) and re-pairing, what counts as a code, codes to the broker (and after a hiccup), the code.slots cursor, send and caller checks, signal-cli failing, the socket file
```
