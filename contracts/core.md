# Core contract (the loop)

**0.1-draft.** The agent itself: read the message, think, call the other parts, reply. It knows the other parts only through their contracts. **The target size is a few hundred lines.** If it grows past about 1,000, stop and ask why.

## What the core serves

The core listens on one socket for `channel.inbound` ([channel.md](channel.md)) and for `grant.event` notifications from the broker:

`grant.event` args `{ grant_id, state }`, sent when a grant is approved, denied or expires, so the core can carry on without polling.

## The loop

1. An inbound message arrives. It's attached to the open errand for that sender and channel, or a new errand starts (new `errand_id`).
2. The message is appended to `conversation.jsonl`.
3. The core calls `infer` ([router.md](router.md)) with the errand's conversation and the tool list below.
4. It runs any tool calls against the broker or the context gateway, feeds the results back, and repeats until the model stops.
5. It sends the reply with `channel.send` and appends it to the conversation log.

## Tools the model sees

| Tool | Maps to |
|---|---|
| `search_*`, `browse_*` | `mcp.call` / `browser.*` under a standing grant |
| `request_booking` | `grant.request` with `mode: one_shot`, `ops: ["book"]` and exact constraints, then sends the person the approval link with the option restated |
| `complete_booking` | the binding `mcp.call` / `browser.act`, only after `grant.event` says the one-shot grant is approved |
| `read_context` | `context.read` (off unless the errand needs it) |
| `send_message` | `channel.send` |

**No tool returns a secret, because none exists to return.**

## Rules

- **Binding acts need the passkey.** The core can't complete a booking on its own say-so: the broker refuses without an approved one-shot grant, and only the person can approve one.
- **Ask, don't assume.** If anything needed for the act is missing or ambiguous, ask the person. Don't request a grant on a guess.
- **Declare where possible, log where not.** Before a binding act on a relying party that can't receive a declaration, call `identity.declaration` so the would-be declaration is logged.
- **Sign broker requests** with the agent key (`identity.sign`, `caller_proof`).
- Config (`core.toml`) gives socket paths, the router URL and the allowlisted sender per channel. Nothing else is hard-coded.

## The fixture errand (the integration test)

The core plus every other part's fixture completes a scripted booking end to end: request → search → one option → approval link → (fixture approves) → booking → confirmation message → `history verify` passes. Every PR keeps this green.
