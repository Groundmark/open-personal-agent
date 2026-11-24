# Core

The agent itself ([contract](../../contracts/core.md)): read the message, think, call the other parts, reply. It reaches them only through their contracts: the router (`infer`), the broker (grants, `mcp.call`, identity) and the channel adapters (`channel.send`). It holds no secret.

**Status:** first version, for bookings at places reached through the broker's `mcp.call`. No runtime dependencies.

- **Errands** are kept per person and channel, saved to `errands.json`, so a restart resumes them. An errand idle for 6 hours ends; the next message starts a new one.
- **The loop:** each message goes to `conversation.jsonl` (hash-chained; `parts/history` verifies it), then the model is asked with the errand's messages and the tools, tools run, and it repeats until the model answers (at most 8 steps).
- **Tools the model sees:** `request_booking` (a one-shot `book` grant with exact constraints; the approval goes to the person with the agent's reply, as one message), `complete_booking` (only once the broker says the grant is approved; logs `identity.declaration`, then the binding `mcp.call`), and `search_tables` where a place offers it (a standing `search` grant).
- **Approvals pause the errand.** The broker's `grant.event` resumes it: the model is told the person approved, declined or didn't answer.

Not yet: `read_*`, sign-in tools (`ask_to_sign_in`, `sign_in_with_saved_login`, `enter_code`), `read_context`, `request_order_change`, deadlines from `notices`.

```
npm test   # 7 tests with the fixtures around the real core: a booking end to end, a decline, and recovery after a crash or restart (approvals that arrived while down, interrupted turns and tool calls, an outcome that can't be confirmed)
```

Tried live with `anthropic/claude-haiku-5.5` (via `parts/router` and OpenRouter): it books straight away when the message has everything, and asks for what's missing otherwise.
