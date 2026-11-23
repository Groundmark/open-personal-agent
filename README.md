# Open Personal Agent

A personal agent that does real errands, built only from parts the person owns or can swap: their credentials, their context, their history, the inference they choose, and a front end they like using. Swap any one part and the rest keeps working.

This is a reference implementation. Today's personal agents are captive: the platform holds the credentials, the context and the history. This one shows the alternative, in code small enough to read.

**Status: pre-alpha.** Contracts v0.2-draft are in [`contracts/`](contracts/). Nothing runs yet.

## The parts

| Part | What it does | Directory |
|---|---|---|
| Credentials (broker) | Holds secrets and acts on them under grants the person approves with a passkey. The agent never sees a raw secret | `parts/broker` |
| Browser worker | Drives websites for services with no API, on the broker's side of the seam. It never disguises itself | `parts/browser-worker` |
| Personal context | Scoped reads of what the agent may know about the person | `parts/context-gateway` |
| History | A signed, append-only action log, kept separate from conversation history | `parts/history` |
| Inference | Any model engine behind one small seam | `parts/router` |
| Front end | Where the person talks to the agent. Signal first | `parts/channel-signal` |
| Core | The loop that joins them, knowing each part only by its contract | `parts/core` |

Each part is its own process, talks over a documented contract (`contracts/`), and ships a fixture so it can be built and tested without any of the others.

## First errand

A restaurant booking, done end to end: the person asks from their phone, the agent finds options and asks only for what's missing, and the person confirms the booking with a passkey.

## Principles

- **Each part is replaceable without touching the others.**
- **The agent never holds a raw secret.** It asks the broker.
- **Nothing is hidden.** Logs and history are plain and readable without the agent running.
- **Honest automation.** The agent identifies itself. No stealth browsers, no passing as human.
- **Simplicity is the measure.** Lines, dependencies and hours are recorded per part.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Everything is built and tested against fixtures; you don't need access to anyone's accounts.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
