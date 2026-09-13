import { useRef, useState } from 'react';

import { exportTransfer, importTransfer, previewTransfer, type TransferPreview } from '../sync/fileTransfer';
import { saveTextFile, type SaveOutcome } from '../sync/saveFile';
import { TransferFileError } from '../domain/sync/transferFile';
import type { SyncedCollection } from '../domain/sync/types';
import { Sheet } from '../components/Sheet';

/**
 * Moving your data between devices, by hand.
 *
 * This is sync with the network taken out: the same change log, carried in a file
 * instead of over HTTP. Which means it merges rather than overwrites, and that is
 * the thing the screen has to get across — the instinct with a file called
 * "export" is that importing it will flatten whatever is already here, and people
 * who believe that will not use it on the device that has anything worth keeping.
 *
 * So the copy says "merge" everywhere and never says "restore", and the preview
 * lands before anything is written, as it does for recipes.
 */
export function TransferSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const [saved, setSaved] = useState<{ outcome: SaveOutcome; changes: number } | null>(null);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [merged, setMerged] = useState<{ applied: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function doExport(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const file = await exportTransfer();
      const outcome = await saveTextFile(file.filename, file.json);
      setSaved({ outcome, changes: file.changeCount });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    // Cleared so picking a second file after a first one failed does not leave the
    // previous error sitting above the new preview, reading as if it applied to it.
    e.target.value = '';
    if (!file) return;

    setError(null);
    setPreview(null);
    setMerged(null);
    setBusy(true);
    try {
      setPreview(await previewTransfer(await file.text()));
    } catch (err) {
      setError(
        err instanceof TransferFileError
          ? err.message
          : `Could not read that file — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function merge(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await importTransfer(preview.file);
      setMerged({ applied: result.applied, skipped: result.skipped });
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Move data between devices" onClose={onClose}>
      <p className="tiny faint" style={{ marginTop: 0 }}>
        Export a file here, open it on your other device, and the two catch up with
        each other. Nothing is overwritten wholesale — each record keeps whichever
        version was written last, so ticking a list on your phone and editing the
        plan on your laptop both survive the trip.
      </p>

      {/* --- Export ------------------------------------------------------- */}
      <h3 className="section-title">Export from this device</h3>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Your plans, shopping lists, pantry, spending, cooking log, settings and any
        recipes you added. The built-in library is left out — it ships with the app
        on both devices already.
      </p>
      <button className="btn primary block" disabled={busy} onClick={() => void doExport()}>
        {busy ? 'Working…' : 'Export everything'}
      </button>

      {saved && saved.outcome.kind !== 'cancelled' && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--accent)' }}>
          <div className="strong small" style={{ color: 'var(--accent)' }}>
            {saved.outcome.kind === 'shared' ? 'Sent' : 'Saved'}
          </div>
          <div className="tiny dim" style={{ wordBreak: 'break-all' }}>
            {saved.outcome.filename} · {plural(saved.changes, 'record')}
          </div>
        </div>
      )}

      {/* --- Import ------------------------------------------------------- */}
      <h3 className="section-title">Merge in a file</h3>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Pick a file exported from your other device. You will see what it holds
        before anything is written.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e)}
      />
      <button className="btn block" disabled={busy} onClick={() => fileInput.current?.click()}>
        Choose a file
      </button>

      {error && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--danger)' }}>
          <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      {preview && (
        <>
          {preview.sameDevice && (
            <div className="card" style={{ marginTop: 10 }}>
              <span className="small">
                This file was exported from <strong>this</strong> device. Merging it
                changes nothing — you probably want the other device's file.
              </span>
            </div>
          )}

          <div className="stat-grid" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="v">{preview.file.changes.length}</div>
              <div className="k">records in file</div>
            </div>
            <div className="stat">
              <div className="v">{preview.file.exportedAtISO.slice(0, 10) || '—'}</div>
              <div className="k">exported</div>
            </div>
            <div className="stat">
              <div className="v">{preview.file.deviceId || '—'}</div>
              <div className="k">from device</div>
            </div>
          </div>

          <h3 className="section-title">What is in it</h3>
          {preview.summary.map((row) => (
            <div className="card tight row between" key={row.collection}>
              <span className="grow truncate">{LABELS[row.collection]}</span>
              <span className="tiny faint">
                {row.writes > 0 && `${row.writes}`}
                {row.deletes > 0 && `${row.writes > 0 ? ' · ' : ''}${row.deletes} deleted`}
              </span>
            </div>
          ))}

          <button
            className="btn primary block"
            style={{ marginTop: 16 }}
            disabled={busy}
            onClick={() => void merge()}
          >
            {busy ? 'Merging…' : `Merge ${plural(preview.file.changes.length, 'record')}`}
          </button>
          <p className="tiny faint" style={{ marginTop: 6, textAlign: 'center' }}>
            Anything this device has edited more recently is kept.
          </p>
        </>
      )}

      {merged && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent)' }}>
          <div className="strong" style={{ color: 'var(--accent)' }}>Merged</div>
          <div className="small dim">
            {plural(merged.applied, 'record')} updated on this device.
            {merged.skipped > 0 && ` ${plural(merged.skipped, 'record')} left alone — this device had newer.`}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** What each collection is called to someone who has never read the schema. */
const LABELS: Readonly<Record<SyncedCollection, string>> = {
  settings: 'Settings',
  plans: 'Week plans',
  checks: 'Shopping list ticks',
  staples: 'Staples',
  pantry: 'Pantry',
  sales: 'Sale prices',
  carryOver: 'Carried-over stock',
  recipes: 'Your recipes',
  ingredients: 'Your ingredients',
  expenses: 'Spending',
  customItems: 'Added list items',
  barcodes: 'Scanned barcodes',
  cookedMeals: 'Meals cooked',
  leftovers: 'Leftovers',
  mealLog: 'Meal log',
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
