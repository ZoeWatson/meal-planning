import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db } from '../db/database';
import { getSyncMeta } from '../db/syncWrites';
import { generatePairingCode } from '../sync/httpTransport';
import { linkSpace, onSyncChange, sync, unlinkSpace } from '../sync/syncManager';
import { Sheet } from '../components/Sheet';

/**
 * Sync setup and status.
 *
 * The pairing code is shown in full rather than hidden behind a "reveal" — it has
 * to be typed on the other device, and treating it as a secret in the UI while it
 * travels through a text field on a second screen would be theatre. What matters
 * is that the page says plainly what the code protects.
 */
export function SyncSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const [serverUrl, setServerUrl] = useState('http://localhost:8787');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'link' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const meta = useLiveQuery(() => getSyncMeta(), [tick], undefined);
  const pending = useLiveQuery(() => db.outbox.count(), [tick], 0);

  useEffect(() => onSyncChange(() => setTick((n) => n + 1)), []);

  const linked = Boolean(meta?.spaceId);

  async function doLink(): Promise<void> {
    setError(null);
    setNote(null);
    setBusy('link');
    try {
      const { queued } = await linkSpace(serverUrl.trim(), code.trim());
      setNote(`Linked. ${queued} record${queued === 1 ? '' : 's'} queued to upload.`);
      await sync();
      setNote(`Linked and synced. Enter the same code on your other device.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  }

  async function doSync(): Promise<void> {
    setError(null);
    setNote(null);
    setBusy('sync');
    try {
      const result = await sync();
      setNote(
        `Sent ${result.pushed}, received ${result.applied}` +
        (result.dropped > 0 ? `, discarded ${result.dropped} outdated` : '') + '.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <Sheet title="Sync" onClose={onClose}>
      {!linked ? (
        <>
          <p className="small dim" style={{ marginTop: 0 }}>
            Sync keeps your plan and shopping list the same on every device. Generate
            a code here, then enter the same one on your other device.
          </p>

          <div className="field">
            <label htmlFor="server">Sync server</label>
            <input
              id="server"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://meals.example.com"
              autoComplete="off"
            />
            <div className="hint">
              Run <code>npm run sync-server</code> on a machine both devices can
              reach. See <code>server/README.md</code>.
            </div>
          </div>

          <div className="field">
            <label htmlFor="code">Pairing code</label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="basil-cedar-lemon-thyme"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button
              className="btn small ghost"
              style={{ marginTop: 6 }}
              onClick={() => setCode(generatePairingCode())}
            >
              Generate a code
            </button>
          </div>

          <div className="card small dim">
            <strong>The code is the only password.</strong> Anyone who has it can
            read and change your meal plans. That is a fair trade for a personal
            tool — no accounts, nothing between you and a list in a shop — but do
            not reuse a code you have shared, and use HTTPS if the server is on the
            open internet.
          </div>

          <button
            className="btn primary block"
            style={{ marginTop: 12 }}
            disabled={busy !== null || code.trim() === '' || serverUrl.trim() === ''}
            onClick={() => void doLink()}
          >
            {busy === 'link' ? 'Linking…' : 'Link this device'}
          </button>
        </>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="v">{pending ?? 0}</div>
              <div className="k">waiting to send</div>
            </div>
            <div className="stat">
              <div className="v" style={{ fontSize: 13 }}>{relativeTime(meta?.lastSyncedAtISO ?? null)}</div>
              <div className="k">last synced</div>
            </div>
            <div className="stat">
              <div className="v" style={{ fontSize: 13 }}>
                {navigator.onLine ? 'Online' : 'Offline'}
              </div>
              <div className="k">connection</div>
            </div>
          </div>

          {!navigator.onLine && (
            <div className="card small dim" style={{ marginTop: 10 }}>
              No connection. Changes are saved on this device and will sync by
              themselves when you are back online — including everything you tick
              off in a shop.
            </div>
          )}

          <button
            className="btn primary block"
            style={{ marginTop: 12 }}
            disabled={busy !== null}
            onClick={() => void doSync()}
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>

          <h3 className="section-title">Connection</h3>
          <div className="card small">
            <div className="dim">Server</div>
            <div className="truncate" style={{ marginBottom: 8 }}>{meta?.serverUrl}</div>
            <div className="dim">Space</div>
            <div className="truncate" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {meta?.spaceId}
            </div>
          </div>
          <p className="tiny faint">
            To add another device, enter the same pairing code there. The space id
            above is derived from it — it is not the code itself.
          </p>

          <button
            className="btn block danger"
            style={{ marginTop: 8 }}
            disabled={busy !== null}
            onClick={() => void unlinkSpace().then(() => setTick((n) => n + 1))}
          >
            Unlink this device
          </button>
          <p className="tiny faint" style={{ textAlign: 'center' }}>
            Your recipes and plans stay on this device. Unsent changes are discarded.
          </p>
        </>
      )}

      {error && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--danger)' }}>
          <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}
      {note && !error && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent)' }}>
          <span className="small" style={{ color: 'var(--accent)' }}>{note}</span>
        </div>
      )}
    </Sheet>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
