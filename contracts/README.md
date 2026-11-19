# Contracts

One markdown file plus a JSON Schema per seam. **Not yet written** (contracts v0.1 is the first work package).

Common to every seam:

- **Transport:** one JSON object per line over a Unix socket, one request per connection. Inference is the exception: it uses an HTTP seam shaped like a model API.
- **Every request carries** `caller`, `errand_id` (a ULID minted by the core when an errand starts) and `ts`.
- **Every response** is `{ "ok": true, ... }` or `{ "ok": false, "error": "<code>", "message": "..." }`, with a closed list of error codes per seam.
- **Every part ships a fixture** that runs with no network, no account and no secret.
