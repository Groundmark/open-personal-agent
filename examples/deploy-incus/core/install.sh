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
# The passkey must exist (broker/enroll.sh, step 4); a failed run leaves a working web-pinned.json as it was.
incus exec opa -- sh -c 'jq -e "{credentialId: .passkeys[0].credentialId, publicKey: .passkeys[0].publicKey} | select((.credentialId | type) == \"string\" and .credentialId != \"\" and .publicKey != null)" /var/lib/opa/broker/passkeys.json > /etc/opa/web-pinned.json.new 2>/dev/null \
  || { rm -f /etc/opa/web-pinned.json.new; echo "No passkey yet: run broker/enroll.sh and set one up first." >&2; exit 1; }
  chmod 0644 /etc/opa/web-pinned.json.new && mv /etc/opa/web-pinned.json.new /etc/opa/web-pinned.json'
for u in core/opa-core.socket core/opa-core.service web/opa-channel-web.socket web/opa-channel-web.service; do incus file push "$here/$u" "opa/etc/systemd/system/$(basename $u)"; done
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable --now opa-core.socket opa-channel-web.socket && systemctl enable opa-core opa-channel-web && systemctl restart opa-core opa-channel-web'
