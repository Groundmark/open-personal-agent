# Core contract (the loop)

**0.3-draft.** The agent itself: read the message, think, call the other parts, reply. It knows the other parts only through their contracts. **The target size is a few hundred lines.** If it grows past about 1,000, stop and ask why.

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
| `read_*` | `browser.open` (read-only) / `browser.extract` / `mcp.call` under a standing `read` grant: the person's own orders, subscriptions, bookings |
| `search_*`, `browse_*` | `mcp.call` / `browser.*` under a standing grant |
| `ask_to_sign_in` | sends the person "please sign in to <site> on <device>", then `browser.await_login` |
| `sign_in_with_saved_login` | `grant.request` with `credential: { domain }` and `ops: ["login"]`, then `browser.fill_login`. Sets `operator_present` from what the person said. On `credential_ambiguous` it asks which account |
| `enter_code` | `browser.fill_code`, `source: "store_totp"` if the login has a TOTP, else `"person"`, after telling the person "reply with just the code <site> sent you". The model sees only `{ filled: true }` or the error |
| `request_booking`, `request_order_change` | `grant.request` with `mode: one_shot`, `ops: ["book"]` and exact constraints, then sends the person the approval link with the option restated |
| `complete_booking` | the binding `mcp.call` / `browser.act`, only after `grant.event` says the one-shot grant is approved |
| `read_context` | `context.read` (off unless the errand needs it) |
| `send_message` | `channel.send` |

**No tool returns a secret, because none exists to return.**

## Rules

- **Binding acts need the passkey.** The core can't complete a booking on its own say-so: the broker refuses without an approved one-shot grant, and only the person can approve one.
- **Ask, don't assume.** If anything needed for the act is missing or ambiguous, ask the person. Don't request a grant on a guess.
- **Declare where possible, log where not.** Before a binding act on a relying party that can't receive a declaration, call `identity.declaration` so the would-be declaration is logged.
- **Codes are never the model's.** One-time codes, sign-in links and recovery codes never go into the conversation the model reads. Use `enter_code`. If the person pastes a code into an ordinary message anyway, the core doesn't repeat it and doesn't put it in a reply.
- **A refused or missing login is final for the errand.** On `credential_not_found` or `store_no_answer`, tell the person and stop that path. Don't retry, try another credential or try another site on your own.
- **Know where the person is.** Set `operator_present: true` only when the person has said they're at the computer (or the errand started from it). If the store needs them there and they aren't, say so ("I need you at your Mac to release that login") rather than failing quietly.
- **Pass deadlines on.** When a page carries `notices` (a cutoff, an auto-checkout time, a countdown), say the deadline in the reply as an absolute time in the person's zone.
- **Use your own socket.** The core reaches the broker only on `broker-core.sock`, which only its Unix user can open; that is its caller proof ([broker.md](broker.md#caller-proof)).
- Config (`core.toml`) gives socket paths, the router URL and the paired account per channel (read from each adapter's pairing file). Nothing else is hard-coded.

## The fixture errand (the integration test)

The core plus every other part's fixture completes a scripted booking end to end, and a scripted read errand ("what's in my order this week, and until when can I change it?") against the fixture site's standing order: request → search → one option → approval link → (fixture approves) → booking → confirmation message → `history verify` passes. Every PR keeps this green.
