# Web channel

A channel adapter ([contract](../../contracts/channel.md), channel `web`) for talking to the agent from a page on the person's phone or computer, with approvals right in the chat. Our addition alongside Signal.

**Status:** working. No runtime dependencies; the page is plain JavaScript with no libraries.

- **Pairing, mapped onto passkeys.** The account id is the person's passkey credential id and the pinned "identity key" is its public key, copied at install from the broker's `passkeys.json` (public keys aren't secrets). Signing in checks a fresh, user-verified signature by that passkey (`src/webauthn.js`, node:crypto only).
- **A password too, if the config turns it on** (`password_signin: true`; off by default), for a computer with no passkey. Whoever is in the chat can read its history and use any standing grants that are live, so it's a real way in: leave it off unless you need it. With it on, the person sets it once signed in (scrypt, `password.json`, mode 0600). Ten wrong tries in 15 minutes lock it for 15 minutes. Signing in only lets the person talk to the agent; approvals still need the passkey (on a computer the browser offers "use a phone").
- **Approvals in the chat.** A message ending in an approval link becomes a card with Approve and Decline. The page runs the passkey against `/approve/<id>`, which the adapter passes to the broker's approval page (`approval_upstream`) with Host and Origin kept.
- **No history kept here,** as the contract asks: the agent's messages wait in memory until the page fetches them (server-sent events), and the page keeps its own copy on the device.
- Sessions: an HttpOnly, Secure, SameSite=Strict cookie for 30 days.
- **Notifications (Web Push),** with node:crypto only: VAPID (RFC 8292) and the message encrypted for the device (RFC 8291), so the push service carries it without reading it. A device gets one when the agent writes and that device doesn't have the chat open; an approval request's notification says "Your agent needs your OK" with the summary. The server only posts to the browsers' push services (a fixed host list), never to an address a page supplies. On iPhone, notifications work once the chat is on the Home Screen.

```
npm test   # 9 tests: notifications (encryption round trip; who gets one), passkey sign-in (and refusals), password sign-in off by default, password and lockout, messages both ways, recipient and caller checks, the approval pass-through
```
