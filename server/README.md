# Sync server

A dependency-free Node server that keeps two devices in step. It exists so the
app has a working backend you control, not because this is the only backend it
can have — the whole contract is two HTTP calls, so swapping it for Supabase, a
Cloudflare Worker, or anything else means implementing `SyncTransport` and
changing nothing else.

```bash
npm run sync-server                              # port 8787, data in ./server/data
PORT=9000 DATA_DIR=/var/lib/meals npm run sync-server
```

Then in the app: **Settings → Sync settings**, enter the server URL and a pairing
code, and enter the *same* code on your other device.

## How it works

Each space is one append-only NDJSON log. Every accepted change is a line; the
server keeps an in-memory index of the latest change per record and rebuilds it
from the log on start.

Append-only matters for a server nobody is watching: a crash mid-write loses at
most the final line rather than corrupting the file, and the log is readable with
`tail` when something looks wrong.

The server compares HLC timestamps but never interprets them. It only needs to
know that a lexicographically larger string is newer, which is why the client
encodes them fixed-width.

## API

```
GET  /health
GET  /sync/:spaceId/pull?since=<seq>&limit=<n>   → { changes, seq, hasMore }
POST /sync/:spaceId/push  { changes: Change[] }  → { seq, accepted }
```

`seq` is a per-space counter. Clients pull everything above their last cursor. A
push whose HLC is not newer than what the server already holds is accepted and
ignored, so re-sending after a dropped connection is safe.

## Security

**The space id is the only credential.** Anyone who has it can read and write that
space. There are no accounts and no passwords.

That is a deliberate trade for a personal tool — it is what lets you open a
shopping list in a supermarket without a login screen — and it is why this should
hold nothing more sensitive than what you are having for dinner.

The space id is a SHA-256 digest of your pairing code, so the code itself never
reaches the server or its logs. A leaked log gives up the space, not the code.

If you put this on the open internet:

- Terminate TLS in front of it. There is no HTTPS here.
- Restrict who can reach it at all — a VPN, Tailscale, or an authenticating
  reverse proxy. Do not rely on the space id being unguessable as your only layer.
- Use a long pairing code. The generator produces four words from a 24-word list,
  which is fine on a LAN and thin against anyone actually trying.

On a home network or behind Tailscale, none of that matters much and the default
setup is reasonable.

## Operations

Data is plain text under `DATA_DIR`, one file per space. Back it up by copying the
directory. To wipe a space, delete its `.ndjson` file and restart.

The log grows by one line per change, with superseded entries kept on disk but
collapsed in memory. A single user will not notice this for years; if a file ever
does get unwieldy, it can be compacted by replaying it and keeping the last line
per `(collection, id)`.

There is no auth, no rate limiting, and no multi-tenancy beyond the space id.
Those are the things to add first if this ever needs to serve anyone but you.
