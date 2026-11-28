# Example deployment: one person's agent in an Incus container

How one person's agent ran end to end: an Incus container (Debian 13) on a desktop Linux machine, one Unix user per part, systemd sockets, a loopback-only Vaultwarden, and a Cloudflare Tunnel for the two pages the person opens from their phone. It's what ran the booking at the demo restaurant (`table.groundmark.fyi`), approved with a passkey in the chat.

It's an example, not an installer. Names are the ones used there (`groundmark.fyi`, `agent.groundmark.fyi`): change them to your own domain. There are no secrets in it. Keys and passwords are made inside the container, or read from files you keep outside the repo.

## What runs where

| Part | Unix user | Listens on | systemd |
|---|---|---|---|
| router | `opa-router` | `127.0.0.1:8411` (`POST /infer`) | `opa-router.service` |
| broker | `opa-broker` | `/run/opa/broker-core.sock` (only `opa-core` can open it); approval page on `127.0.0.1:8443` | `opa-broker-core.socket`, `opa-broker.service` |
| core | `opa-core` | `/run/opa/core.sock` (group `opa-core-callers`: the broker and channels) | `opa-core.socket`, `opa-core.service` |
| web chat | `opa-web` | `/run/opa/channel-web.sock` (only `opa-core`); page on `127.0.0.1:8081` | `opa-channel-web.socket`, `opa-channel-web.service` |
| Vaultwarden | `opa-vault` | `https://127.0.0.1:8222`, its own certificate, never published | `opa-vault.service` |

The broker's per-caller sockets are the contract's caller proof (contracts/broker.md): systemd creates each socket owned by its one caller, mode `0600`, and hands it to the broker by name (`FileDescriptorName=`), so the broker needs no root.

## Order

From the machine that runs Incus, in this folder:

1. **Container and base system.** `incus launch images:debian/13 opa`, then `incus file push setup/container.sh opa/root/ && incus exec opa -- sh /root/container.sh`. It installs Node 22 (checksum-checked), cloudflared from Cloudflare's signed repository, Unbound (a DNSSEC-validating resolver on loopback), and a user per part. The agent's parts don't use Unbound themselves: it's there for a site in the same box that checks Groundmark signatures (a test restaurant, say), which must look up the agent's key with DNSSEC validation for the check to mean anything.
2. **Router.** Put the model provider's key in a file only you can read, then `OPA_SECRETS=<that directory> router/install.sh`. The key goes to `/etc/opa/credentials/inference-openrouter` (root, `0600`) and reaches the router through systemd `LoadCredential=`. Edit `router/router.toml` for another provider or model.
3. **Tunnel.** Create a remotely managed tunnel in the Cloudflare dashboard (see below for its hostnames), put its token in a file only you can read, then `OPA_SECRETS=<that directory> tunnel/install.sh`. It comes before the broker because step 5's passkey link opens on `approve.<domain>`.
4. **Vault (optional).** Copy `vault/vaultwarden.env.example` to `vault/vaultwarden.env`, then `vault/install.sh` fetches Vaultwarden 1.37.5 from its official image (pinned by digest, no Docker), creates the agent's account, a collection with two fake logins, and the account's API key, and installs the `bw` CLI (pinned). It prints the collection id: put it in `broker/broker.json`. Leave out `vault` in `broker.json` to run without one.
5. **Broker.** `broker/install.sh`. Then `broker/enroll.sh` prints a one-time link (and a QR code on a terminal) to set up the passkey that approves the agent's requests: open it on the phone you'll approve with. `broker/test-grant.sh` asks for a harmless test grant and prints its approval link.
6. **Core and web chat.** `core/install.sh` installs both and pins the person's passkey (its public key, from the broker) for chat sign-in. Signing in is passkey only: `web/web.json` has `"password_signin": false`. Whoever is in the chat can read its history and use any standing grants that are live, so turn a password on only for a computer that has no passkey, and only if you need it.

## Outside the container

- **Cloudflare Tunnel** (step 3). Don't use `cloudflared service install <token>`: it puts the token in a unit file every user can read and on the command line. `tunnel/install.sh` keeps it in `/etc/cloudflared/token` (root, `0600`) and runs `cloudflared tunnel run --token-file`. Public hostnames:
  - `approve.<domain>` → `http://127.0.0.1:8443` (the broker's approval page)
  - `chat.<domain>` → `http://127.0.0.1:8081` (the web chat)
- **The agent's identity in DNS (Groundmark).** Publish the agent's public key at `_agentid.<agent domain>` as a TXT record:

  ```
  v=gm1; k=ed25519; kid=k1; p=<the raw 32-byte public key, base64url>
  ```

  Get `p` with `incus exec opa -- node -e 'const k=require("crypto").createPublicKey(require("fs").readFileSync("/var/lib/opa/broker/agent.pub"));console.log(k.export({format:"jwk"}).x)'`. `agent_keyid` in `broker.json` is `<agent domain>#k1`. Turn on DNSSEC for the zone: relying parties trust the key only through a validated answer.
- **Passkeys** are bound to `rp_id` (`groundmark.fyi` here), so the approval page and the chat must be on that domain or under it.
- **The chat is an approval origin too.** `broker.json` lists `https://chat.<domain>` in `approval.origins`, so approvals can happen right in the chat. That makes the web channel (`opa-web`, the part facing the internet) as sensitive as the broker: if it were compromised, it could show an innocent-looking card while collecting a real approval. Keeping approvals on the broker's own page only would mean taking the chat out of `approval.origins` and changing the chat page to open `approve.<domain>` for each card (today it approves in place, so the cards would stop working).

## Things specific to Incus

- **Incus switches systemd credentials off** with a drop-in on every service. The install scripts add a later drop-in (`zzzz-credentials.conf`) that sets `LoadCredential=` again, and it works inside the container: the credential lands in `/run/credentials/<unit>/`, readable only by that service's user.
- **IPv6:** the Incus bridge gave out IPv6 addresses with no route out, so `container.sh` makes the resolver prefer IPv4 (`/etc/gai.conf`).
- Unbound needs `dns-root-data` for its trust anchor; `container.sh` installs it.
- **More hardening, if you want it:** `ProtectProc=invisible` on the part units, and `IPAddressDeny=any` with `IPAddressAllow=localhost` for the core (the web chat needs the internet for push). Not set here.
