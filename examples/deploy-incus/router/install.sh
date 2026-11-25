#!/bin/sh
# From the desktop: installs parts/router and its config into the opa container.
# The provider key is read from $OPA_SECRETS/inference-openrouter (a file only you can read) and never printed.
set -eu
here=$(dirname "$0"); src=$here/../../../parts/router
tar -C "$src" -czf - package.json src | incus exec opa -- sh -c 'rm -rf /opt/opa/router && mkdir -p /opt/opa/router && tar -xzf - -C /opt/opa/router && chmod -R a+rX /opt/opa/router'
incus exec opa -- install -d -m 0755 /etc/opa
incus exec opa -- install -d -m 0700 /etc/opa/credentials
incus file push --mode 0644 "$here/router.toml" opa/etc/opa/router.toml
incus exec opa -- sh -c 'umask 077; cat > /etc/opa/credentials/inference-openrouter' < "${OPA_SECRETS:?set OPA_SECRETS to the directory holding inference-openrouter}/inference-openrouter"
incus file push "$here/opa-router.service" opa/etc/systemd/system/opa-router.service
incus exec opa -- sh -c 'systemctl daemon-reload && systemctl enable opa-router && systemctl restart opa-router'
# Incus adds a drop-in to every service that switches systemd credentials off; switch them back on for
# this one (it works here: the credential lands in /run/credentials/opa-router.service, readable only by opa-router).
incus exec opa -- sh -c 'mkdir -p /etc/systemd/system/opa-router.service.d && printf "[Service]\nLoadCredential=inference-openrouter:/etc/opa/credentials/inference-openrouter\n" > /etc/systemd/system/opa-router.service.d/zzzz-credentials.conf && systemctl daemon-reload && systemctl restart opa-router'
