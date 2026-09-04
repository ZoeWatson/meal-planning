/**
 * Reference sync server.
 *
 * Deliberately dependency-free Node, so it runs on a laptop, a Raspberry Pi, or
 * any small host without a build step or a package install. It is the *reference*
 * implementation of a two-method contract — swap it for Supabase, a Cloudflare
 * Worker, or anything else and the app does not change.
 *
 *   node server/index.mjs                    # port 8787, ./server/data
 *   PORT=9000 DATA_DIR=/var/meals node server/index.mjs
 *
 * Storage is one append-only NDJSON log per space plus an in-memory index of the
 * latest change per record. Append-only means a crash mid-write loses at most the
 * final line rather than corrupting the file, and the log is trivially inspectable
 * with `tail` when something looks wrong.
 *
 * SECURITY, stated plainly: the space id is the only credential. Anyone who has it
 * can read and write that space. That is a deliberate trade for a personal tool —
 * no accounts, no passwords, nothing between you and a shopping list in a shop —
 * and it is why this should hold nothing more sensitive than what you are having
 * for dinner. Put it behind HTTPS and, if it is on the open internet, something
 * that restricts who can reach it at all.
 */

import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'server', 'data');
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGE = 1000;

/** spaceId -> { seq, records: Map<"collection id", change>, order: change[] } */
const spaces = new Map();

const SPACE_ID_PATTERN = /^[a-f0-9]{8,64}$/;

function logPath(spaceId) {
  return join(DATA_DIR, `${spaceId}.ndjson`);
}

async function loadSpace(spaceId) {
  const cached = spaces.get(spaceId);
  if (cached) return cached;

  const space = { seq: 0, records: new Map(), order: [] };
  const path = logPath(spaceId);

  if (existsSync(path)) {
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const change = JSON.parse(line);
        applyToSpace(space, change);
      } catch {
        // A torn final line from an interrupted write. Skipping it is correct:
        // the client still has that change queued and will send it again.
      }
    }
  }

  spaces.set(spaceId, space);
  return space;
}

/**
 * Records a change in the space's index.
 *
 * The server compares HLC strings but never interprets them — that is the point
 * of the fixed-width encoding. It only needs to know that lexicographically larger
 * means newer, so it can reject a stale change without understanding clocks.
 */
function applyToSpace(space, change) {
  const key = `${change.collection} ${change.id}`;
  const existing = space.records.get(key);

  if (existing && existing.hlc >= change.hlc) return false;

  space.seq += 1;
  const stored = { ...change, seq: space.seq };
  space.records.set(key, stored);

  // The order array is the pull feed. Superseded entries are dropped so a record
  // edited a hundred times costs one entry, not a hundred.
  if (existing) {
    const at = space.order.findIndex((c) => c.collection === change.collection && c.id === change.id);
    if (at !== -1) space.order.splice(at, 1);
  }
  space.order.push(stored);
  return true;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error('[sync] unhandled', err);
    send(res, 500, { error: 'Internal error' });
  });
});

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    send(res, 200, { ok: true, spaces: spaces.size });
    return;
  }

  const match = /^\/sync\/([^/]+)\/(push|pull)$/.exec(url.pathname);
  if (!match) {
    send(res, 404, { error: 'Not found' });
    return;
  }

  const [, rawSpaceId, action] = match;
  const spaceId = decodeURIComponent(rawSpaceId);

  // The space id becomes a filename, so it is validated rather than sanitised —
  // anything that is not a plain hex digest is rejected outright.
  if (!SPACE_ID_PATTERN.test(spaceId)) {
    send(res, 400, { error: 'Invalid space id' });
    return;
  }

  const space = await loadSpace(spaceId);

  if (action === 'pull' && req.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));

    const pending = space.order.filter((c) => c.seq > since);
    const page = pending.slice(0, limit);

    send(res, 200, {
      changes: page,
      // The cursor only advances past what was actually sent, so an interrupted
      // pull resumes rather than skipping the remainder.
      seq: page.length > 0 ? page[page.length - 1].seq : since,
      hasMore: pending.length > page.length,
    });
    return;
  }

  if (action === 'push' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      send(res, 400, { error: String(err instanceof Error ? err.message : err) });
      return;
    }

    const changes = Array.isArray(body.changes) ? body.changes : [];
    const lines = [];
    let accepted = 0;

    for (const change of changes) {
      if (!change || typeof change.collection !== 'string' || typeof change.id !== 'string'
          || typeof change.hlc !== 'string') {
        continue;
      }
      if (applyToSpace(space, change)) {
        accepted++;
        lines.push(JSON.stringify(change));
      }
    }

    if (lines.length > 0) {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(logPath(spaceId), `${lines.join('\n')}\n`, 'utf8');
    }

    send(res, 200, { seq: space.seq, accepted });
    return;
  }

  send(res, 405, { error: 'Method not allowed' });
}

await mkdir(DATA_DIR, { recursive: true });

// Existing spaces are loaded lazily; this only reports what is on disk at start.
const existing = existsSync(DATA_DIR)
  ? (await readdir(DATA_DIR)).filter((f) => f.endsWith('.ndjson')).length
  : 0;

server.listen(PORT, () => {
  console.log(`Meal sync server on http://localhost:${PORT}`);
  console.log(`  data:   ${DATA_DIR} (${existing} existing space${existing === 1 ? '' : 's'})`);
  console.log(`  health: http://localhost:${PORT}/health`);
  console.log('\nThe space id is the only credential. Serve over HTTPS if this is not on your LAN.');
});
