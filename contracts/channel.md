# Channel contract (front end)

**0.2-draft.** Where the person talks to the agent. Every front end (Signal first, iMessage next, a terminal for tests) speaks the same two messages, so swapping one changes nothing else.

## Messages

**adapter → core:** `channel.inbound`, sent to the core's socket.

```json
{ "channel": "signal", "message_id": "…", "from": "<account id>", "from_display": "…", "text": "…", "attachments": [], "received_at": "…" }
```

**core → adapter:** `channel.send`, sent to the adapter's socket.

```json
{ "channel": "signal", "to": "<account id>", "text": "…", "attachments": [], "reply_to": "<message_id>?" }
```

result: `{ "message_id", "sent_at" }`

- `from` and `to` are the channel's **stable account id**, never a phone number or a display name. For Signal that's the account's ACI (a UUID). Signal hides phone numbers by default, so a message from the person usually arrives with no number at all.
- `from_display` is the sender's self-chosen profile name. It's for logs and conversation only. **Anyone can set any name, so it never decides anything.**
- `attachments` items are `{ "name", "mime", "path" }`, a file in a directory both parts can read. Bytes don't go inline.

## Pairing and the allowlist

The adapter forwards only messages from a **paired** account. Pairing ties the person to one account id and pins that account's identity key.

1. **At setup** the adapter generates a one-time pairing code: six digits, valid for 15 minutes, single use. The installer shows it to the person, on the machine, never over the channel.
2. **The person sends the code** to the agent from their own account.
3. **The adapter pins that account:** its account id plus its current identity key fingerprint (for Signal, the safety number). It replies "Paired." The code is now spent.
4. **From then on** it forwards a message only if both the account id and the identity key match. Anything else is dropped and counted, never forwarded, and gets no reply.
5. **If the pinned account's identity key changes** (a new phone, a reinstall, or someone else), the adapter stops forwarding, logs `identity_changed`, and needs a new pairing. It never accepts the new key on its own.

Pairing state is plain JSON in the adapter's config directory: `{ channel, account_id, identity_key, paired_at }`. Deleting it unpairs.

## Rules

- **The agent may speak first.** `channel.send` needs no preceding inbound message. It goes only to the paired account (`recipient_not_allowed` otherwise).
- **The adapter keeps no conversation history.** The core owns it ([history.md](history.md)), which is what lets a conversation move to another front end.
- **A message is never a confirmation of a binding act.** Bookings and payments are confirmed with a passkey through the broker ([broker.md](broker.md)). The channel only carries the link.
- **One adapter owns the account.** Some channels hand each message to whoever asks first (Signal's `receive` consumes what it returns). Only the adapter may receive for the agent's account: run it as the account's single long-lived client (for signal-cli, `daemon` or `jsonRpc` mode), and never run a second receiver beside it.
- **The agent's account has a profile name,** so the person can tell it apart, for example "Sam's agent".

## Errors

`recipient_not_allowed`, `not_paired`, `channel_unavailable`, `attachment_too_large`, plus the common errors.

## Fixture

A terminal channel. stdin becomes `channel.inbound` from a simulated account with an identity key, and `channel.send` prints to stdout. It implements pairing, so tests cover a stranger, a spoofed display name and a changed identity key.
