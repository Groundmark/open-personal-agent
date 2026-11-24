#!/bin/sh
# From the desktop: installs parts/broker into the opa container and (re)starts it.
set -eu
here=$(dirname "$0"); src=$here/../../../parts/broker
tar -C "$src" -czf - package.json package-lock.json src approval | incus exec opa -- sh -c '
  rm -rf /opt/opa/broker.new && mkdir -p /opt/opa/broker.new && tar -xzf - -C /opt/opa/broker.new &&
  cd /opt/opa/broker.new && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null &&
  rm -rf /opt/opa/broker && mv /opt/opa/broker.new /opt/opa/broker && chmod -R a+rX /opt/opa/broker'
incus exec opa -- install -d -m 0755 /etc/opa
incus exec opa -- sh -c 'getent group opa-core-callers >/dev/null || groupadd --system opa-core-callers'   # the broker calls the core by this group
incus file push --mode 0644 "$here/broker.json" opa/etc/opa/broker.json
for u in opa-broker-core.socket opa-broker.service; do incus file push "$here/$u" "opa/etc/systemd/system/$u"; done
# The vault's credentials, by systemd LoadCredential= (re-enabled after Incus's drop-in switches it off), and the bw state dir.
incus exec opa -- sh -c 'install -d -o opa-broker -g opa-broker -m 0700 /var/lib/opa/broker/bw && mkdir -p /etc/systemd/system/opa-broker.service.d && printf "[Service]\nLoadCredential=bw-client-id:/etc/opa/credentials/bw-client-id\nLoadCredential=bw-client-secret:/etc/opa/credentials/bw-client-secret\nLoadCredential=bw-password:/etc/opa/credentials/bw-password\n" > /etc/systemd/system/opa-broker.service.d/zzzz-credentials.conf'
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable --now opa-broker-core.socket && systemctl enable opa-broker && systemctl restart opa-broker'
