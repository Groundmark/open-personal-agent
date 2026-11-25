#!/bin/sh
# Sets up the `opa` Incus container (Debian 13) for the open personal agent.
# Run inside the container as root. Safe to run again.
#   incus file push container.sh opa/root/ && incus exec opa -- sh /root/container.sh
set -eu

NODE_VERSION=v22.23.5            # pinned; checked against nodejs.org's SHASUMS256.txt
PARTS="core broker router context worker signal web history"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq --no-install-recommends ca-certificates curl git gnupg xz-utils unbound dns-root-data dnsutils jq

# The Incus bridge gives out IPv6 addresses but has no IPv6 route out: prefer IPv4 everywhere.
grep -q '^precedence ::ffff:0:0/96' /etc/gai.conf 2>/dev/null || echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf

# Node 22, official tarball, checksum verified.
if [ "$(node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  f="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $f\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$f" -C /opt/node --strip-components=1
  for b in node npm npx; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done
  rm -rf "$tmp"
fi

# cloudflared from Cloudflare's signed apt repository.
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -yq cloudflared
fi

# Unbound: DNSSEC-validating resolver on loopback only (the Groundmark verifier needs the AD bit).
cat > /etc/unbound/unbound.conf.d/opa.conf <<'EOF'
server:
  interface: 127.0.0.1
  access-control: 127.0.0.0/8 allow
  harden-dnssec-stripped: yes
  val-log-level: 1
EOF
systemctl reset-failed unbound 2>/dev/null || true
systemctl enable unbound
systemctl restart unbound

# One Unix user per part: the broker's per-caller sockets rely on these (contracts v0.3, caller proof).
for p in $PARTS; do
  id "opa-$p" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/opa/$p" --shell /usr/sbin/nologin "opa-$p"
  chmod 0700 "/var/lib/opa/$p"
done
chmod 0755 /var/lib/opa

# Socket directory: each part makes its own sockets inside; the directory only lets users through.
cat > /etc/tmpfiles.d/opa.conf <<'EOF'
d /run/opa 0711 root root -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/opa.conf

echo "node $(node --version), npm $(npm --version), $(cloudflared --version | head -1)"
echo "unbound: $(dig +short @127.0.0.1 +dnssec cloudflare.com A | head -1); AD flag:" \
  "$(dig @127.0.0.1 +dnssec cloudflare.com A | grep -c ' ad')"
