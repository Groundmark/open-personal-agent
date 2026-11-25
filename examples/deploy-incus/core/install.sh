#!/bin/sh
# From the desktop: installs parts/core and parts/channel-web into the opa container, pins the person's
# passkey (public key only, from the broker) for the web channel, and (re)starts both.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd); parts=$here/../../parts
for p in core channel-web; do
  tar -C "$parts/$p" -czf - package.json src $( [ -d "$parts/$p/page" ] && echo page ) | incus exec opa -- sh -c "rm -rf /opt/opa/$p && mkdir -p /opt/opa/$p && tar -xzf - -C /opt/opa/$p && chmod -R a+rX /opt/opa/$p"
done
incus exec opa -- sh -c 'getent group opa-core-callers >/dev/null || groupadd --system opa-core-callers'
incus file push --mode 0644 "$here/core/core.json" opa/etc/opa/core.json
incus file push --mode 0644 "$here/web/web.json" opa/etc/opa/web.json
incus exec opa -- sh -c 'jq "{credentialId: .passkeys[0].credentialId, publicKey: .passkeys[0].publicKey}" /var/lib/opa/broker/passkeys.json > /etc/opa/web-pinned.json && chmod 0644 /etc/opa/web-pinned.json'
for u in core/opa-core.socket core/opa-core.service web/opa-channel-web.socket web/opa-channel-web.service; do incus file push "$here/$u" "opa/etc/systemd/system/$(basename $u)"; done
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable --now opa-core.socket opa-channel-web.socket && systemctl enable opa-core opa-channel-web && systemctl restart opa-core opa-channel-web'
