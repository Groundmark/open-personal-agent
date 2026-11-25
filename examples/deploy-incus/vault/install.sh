#!/bin/sh
# Installs Vaultwarden (fetched by fetch-vaultwarden.sh) as a loopback-only service in the opa container, creates the
# agent's account, collection and fake logins once, and installs the bw CLI for the broker. Credentials go to
# /etc/opa/credentials (root, 0600), for the broker's systemd LoadCredential=. Safe to run again.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
incus exec opa -- sh -c 'id opa-vault >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/opa/vault --shell /usr/sbin/nologin opa-vault; chmod 0700 /var/lib/opa/vault'
[ -x "$(incus exec opa -- sh -c 'command -v /opt/vaultwarden/vaultwarden' || true)" ] || { incus file push "$here/fetch-vaultwarden.sh" opa/root/fetch-vaultwarden.sh; incus exec opa -- sh /root/fetch-vaultwarden.sh; }
incus file push --mode 0644 "$here/vaultwarden.env" opa/etc/opa/vaultwarden.env
# A certificate for 127.0.0.1 (the bw CLI needs HTTPS); the key is Vaultwarden's alone.
incus exec opa -- sh -c '[ -f /etc/opa/vault-tls/cert.pem ] || { install -d -m 0755 /etc/opa/vault-tls && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes -subj /CN=opa-vault -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout /etc/opa/vault-tls/key.pem -out /etc/opa/vault-tls/cert.pem 2>/dev/null && chown opa-vault /etc/opa/vault-tls/key.pem && chmod 0600 /etc/opa/vault-tls/key.pem && chmod 0644 /etc/opa/vault-tls/cert.pem; }'
incus file push "$here/opa-vault.service" opa/etc/systemd/system/opa-vault.service
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable opa-vault'
if ! incus exec opa -- test -f /etc/opa/credentials/bw-client-id; then
  # First time: allow one sign-up just for the setup, then close it again.
  # (An EnvironmentFile, since systemd lets EnvironmentFile settings override Environment= ones.)
  incus exec opa -- sh -c 'printf "SIGNUPS_ALLOWED=true\n" > /etc/opa/vaultwarden-setup.env && mkdir -p /etc/systemd/system/opa-vault.service.d && printf "[Service]\nEnvironmentFile=/etc/opa/vaultwarden-setup.env\n" > /etc/systemd/system/opa-vault.service.d/setup.conf && systemctl daemon-reload && systemctl restart opa-vault && sleep 2'
  incus file push "$here/setup-account.mjs" opa/root/setup-account.mjs
  incus exec opa -- sh -c 'install -d -m 0700 /etc/opa/credentials && NODE_EXTRA_CA_CERTS=/etc/opa/vault-tls/cert.pem node /root/setup-account.mjs https://127.0.0.1:8222 agent@groundmark.fyi /etc/opa/credentials > /etc/opa/vault-ids.json && rm /root/setup-account.mjs'
  incus exec opa -- sh -c 'rm -f /etc/systemd/system/opa-vault.service.d/setup.conf /etc/opa/vaultwarden-setup.env && systemctl daemon-reload'
fi
incus exec opa -- systemctl restart opa-vault
# The bw CLI, pinned (2026.10.1), for the broker.
incus exec opa -- sh -c '[ -x /opt/opa/bw/node_modules/.bin/bw ] || { mkdir -p /opt/opa/bw && cd /opt/opa/bw && npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund @bitwarden/cli@2026.10.1 >/dev/null; chmod -R a+rX /opt/opa/bw; }; /opt/opa/bw/node_modules/.bin/bw --version'
incus exec opa -- cat /etc/opa/vault-ids.json
