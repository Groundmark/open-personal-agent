# Context gateway contract (personal context)

**0.1-draft.** Answers questions about the person, one named slice (a **scope**) at a time, and records every read. The store behind it is swappable. The first is a Postgres + pgvector thought store.

## Operations

### `context.scopes`

args `{}` → result `{ "scopes": [{ "name", "description" }] }`

### `context.read`

args `{ "scope", "query"?, "limit"? }` → result `{ "read_id", "items": [{ "id", "text", "captured_at" }] }`

- `query` narrows the read inside the scope (semantic or keyword, depending on the store). Without it, the scope's most relevant items come back.
- `limit` defaults to 10, with a max of 50.

## Scopes

Scopes are defined in a plain file the person edits (`scopes.toml`, with a markdown twin for reading). Each scope is:

- **a filter:** explicit tags first. Semantic search is allowed only inside a tag filter, never as the whole filter.
- **plus a hard denylist** applied after the filter: categories that never come back from any scope, such as health and other people's private details, unless the person moves them out of the denylist.

## Rules

- **Every read is logged** to the context-read log ([history.md](history.md)): `read_id`, `errand_id`, scope, query, the item ids returned. The person can see exactly what the agent read.
- The store's access key comes through `CredentialStore` and never reaches the core.

## Errors

`unknown_scope`, `store_unavailable`, plus the common errors.

## Fixture

A fixture store with fake items, including denylisted ones that must **never** be returned. The fixture test fails if one is.
