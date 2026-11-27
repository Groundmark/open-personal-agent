# Core

The agent itself ([contract](../../contracts/core.md)): read the message, think, call the other parts, reply. It reaches them only through their contracts: the router (`infer`), the broker (grants, `mcp.call`, identity) and the channel adapters (`channel.send`). It holds no secret.

**Status:** first version, for bookings at places reached through the broker's `mcp.call`. No runtime dependencies.

- **Errands** are kept per person and channel, saved to `errands.json`, so a restart resumes them. An errand idle for 6 hours ends; the next message starts a new one.
- **The loop:** each message goes to `conversation.jsonl` (hash-chained; `parts/history` verifies it), then the model is asked with the errand's messages and the tools, tools run, and it repeats until the model answers (at most 8 steps).
- **Tools the model sees:** `request_booking` (a one-shot `book` grant with exact constraints; the approval goes to the person with the agent's reply, as one message), `complete_booking` (only once the broker says the grant is approved; logs `identity.declaration`, then the binding `mcp.call`), and `search_tables` where a place offers it (a standing `search` grant).
- **Approvals pause the errand.** The broker's `grant.event` resumes it: the model is told the person approved, declined or didn't answer. Several approvals asked for in one turn all go out with the reply.

**After a crash or an outage** (details at the top of `src/core.js`):
- A message is saved (and logged) before the channel is told it arrived; a repeat of the same `message_id` is answered once.
- Each step is saved before its tools run, and each tool's result as soon as it's known. At start, a turn that was running is finished, and a tool call left without a result is told its outcome is unknown. What was interrupted is queued before the socket opens, so it goes ahead of new messages.
- Replies are kept until the channel takes them, oldest first, and retried (after 5 s, 30 s and 2 min, then at the next event or restart). Delivery is at least once: a crash just after a send can repeat that message, never lose it.
- If the router is down or answers nonsense, the person is told so. A step's tools aren't run on the last allowed step, and the reply says so.
- An errand waiting on an approval or an undelivered reply isn't replaced after the idle time. The model sees the last 60 messages, widened back to the start of a turn so no tool result is cut from its call.
- If `errands.json` or `conversation.jsonl` can't be written, the core stops (systemd restarts it from the last checkpoint) rather than carry on from state it can't keep. A last log line cut off mid-write is set aside (`conversation.jsonl.partial-<time>`) and the core starts from the line before.
- Still open: a `grant.request` the broker accepted whose answer never reached the core (a crash in between) leaves a grant whose link the person never sees; it expires unused. Fixing that needs a way to look grants up at the broker by request.

Not yet: `read_*`, sign-in tools (`ask_to_sign_in`, `sign_in_with_saved_login`, `enter_code`), `read_context`, `request_order_change`, deadlines from `notices`.

```
npm test   # 23 tests, ~8 s. 7 with the fixtures around the real core (a booking end to end, a decline, recovery after a restart); 16 in test/recovery.test.js with stand-ins, including the real core killed with SIGKILL mid-turn and started again
```

Tried live with `anthropic/claude-haiku-5.5` (via `parts/router` and OpenRouter): it books straight away when the message has everything, and asks for what's missing otherwise.
