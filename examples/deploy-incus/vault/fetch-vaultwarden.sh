#!/bin/sh
# Run inside the container as root: fetches Vaultwarden from its official Alpine image (a static binary and the
# web vault), pinned by digest, each layer checked against its sha256, into /opt/vaultwarden. No Docker needed.
set -eu
IMAGE=vaultwarden/server
DIGEST=sha256:bda2ee084beddcb179ca433a2c24a548205fef9d3807319e3d27aed02eeed3ce   # 1.37.5-alpine, linux/amd64
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$IMAGE:pull" | jq -r .token)
api="https://registry-1.docker.io/v2/$IMAGE"
curl -fsS -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" "$api/manifests/$DIGEST" > "$work/manifest.json"
[ "sha256:$(sha256sum "$work/manifest.json" | cut -d' ' -f1)" = "$DIGEST" ] || { echo "manifest digest mismatch"; exit 1; }
mkdir -p "$work/root"
for layer in $(jq -r '.layers[].digest' "$work/manifest.json"); do
  curl -fsSL -H "Authorization: Bearer $token" "$api/blobs/$layer" -o "$work/layer"
  [ "sha256:$(sha256sum "$work/layer" | cut -d' ' -f1)" = "$layer" ] || { echo "layer $layer digest mismatch"; exit 1; }
  tar -xzf "$work/layer" -C "$work/root" 2>/dev/null || true
done
rm -rf /opt/vaultwarden && mkdir -p /opt/vaultwarden
cp "$work/root/vaultwarden" /opt/vaultwarden/vaultwarden && cp -r "$work/root/web-vault" /opt/vaultwarden/web-vault
chmod -R a+rX /opt/vaultwarden && chmod 755 /opt/vaultwarden/vaultwarden
/opt/vaultwarden/vaultwarden --version
