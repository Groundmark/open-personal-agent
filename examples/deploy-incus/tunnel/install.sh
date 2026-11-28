#!/bin/sh
# From the desktop: runs the Cloudflare Tunnel in the opa container. The token (from the Cloudflare dashboard, in a
# file only you can read: $OPA_SECRETS/tunnel-token) goes to /etc/cloudflared/token, root and 0600, and cloudflared
# reads it with --token-file: it's never on a command line (which every user can see in /proc) or in a unit file.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${OPA_SECRETS:?set OPA_SECRETS to the directory holding tunnel-token}"
incus exec opa -- install -d -m 0700 /etc/cloudflared
incus exec opa -- sh -c 'umask 077; cat > /etc/cloudflared/token' < "$OPA_SECRETS/tunnel-token"
incus file push "$here/cloudflared.service" opa/etc/systemd/system/cloudflared.service
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable cloudflared && systemctl restart cloudflared && systemctl is-active cloudflared'
