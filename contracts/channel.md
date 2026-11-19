# Channel contract (front end)

**0.1-draft.** Where the person talks to the agent. Every front end (Signal first, iMessage next, a terminal for tests) speaks the same two messages, so swapping one changes nothing else.

## Messages

**adapter → core:** `channel.inbound`, sent to the core's socket.

```json
{ "channel": "signal", "message_id": "…", "from": "<sender id>", "text": "…", "attachments": [], "received_at": "…" }
```

**core → adapter:** `channel.send`, sent to the adapter's socket.

```json
{ "channel": "signal", "to": "<recipient id>", "text": "…", "attachments": [], "reply_to": "<message_id>?" }
```

result: `{ "message_id", "sent_at" }`

`attachments` items are `{ "name", "mime", "path" }`, a file in a directory both parts can read. Bytes don't go inline.

## Rules

- **Allowlist.** The adapter forwards only messages from senders on its allowlist. For Signal, that's the person's number **and** their pinned safety number. Anything else is dropped and counted, never forwarded.
- **The agent may speak first.** `channel.send` needs no preceding inbound message.
- **The adapter keeps no conversation history.** The core owns it ([history.md](history.md)), which is what lets a conversation move to another front end.
- **A message is never a confirmation of a binding act.** Bookings and payments are confirmed with a passkey through the broker ([broker.md](broker.md)). The channel only carries the link.

## Errors

`recipient_not_allowed`, `channel_unavailable`, `attachment_too_large`, plus the common errors.

## Fixture

A terminal channel: stdin becomes `channel.inbound` from a fixed sender, and `channel.send` prints to stdout.
