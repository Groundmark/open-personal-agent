#!/bin/sh
# Asks the broker, as the core, for a harmless test grant (read-only, 10 minutes, on the demo site) and
# prints its approval link. For trying the passkey approval from a phone.
set -eu
incus exec opa -- runuser -u opa-core -- node -e '
const req = { op: "grant.request", id: "01JD" + "0".repeat(22), caller: "core", errand_id: null, ts: new Date().toISOString(),
  args: { session: { origin: "https://table.groundmark.fyi", browser: "operator" }, ops: ["read"], mode: "standing", ttl_seconds: 600,
          purpose: "Test: check that approving with your passkey works", constraints: { scope: "nothing; this is a test" } } };
const c = require("net").createConnection("/run/opa/broker-core.sock", () => c.write(JSON.stringify(req) + "\n"));
let b = ""; c.on("data", (d) => { b += d; }); c.on("end", () => { const r = JSON.parse(b); console.log(r.ok ? r.result.summary + "\n" + r.result.approve_url : r); });'
