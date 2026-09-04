import { useRef, useState } from 'react';

import { commitImport, dryRunImport, exportLibrary } from '../db/repository';
import { summarizeUnconvertible, summarizeUnresolved, type ImportBundle, type ImportResult } from '../domain/import/importer';
import { stubsFromResult } from '../domain/import/stubs';
import { Sheet } from '../components/Sheet';

/**
 * In-app import and export.
 *
 * The bulk authoring loop lives at the command line, where a 500-recipe file
 * belongs. This exists for the other half: bringing in a finished file on the
 * device you actually cook from, and getting a backup out of the only copy of
 * your data that exists.
 *
 * Validation is always shown before anything is written. Importing several
 * hundred recipes is not something to find out you got wrong afterwards.
 */
export function ImportSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ ingredients: number; recipes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function check(source: string): Promise<void> {
    setError(null);
    setResult(null);
    setCommitted(null);

    let bundle: ImportBundle;
    try {
      const parsed: unknown = JSON.parse(source);
      // A bare array is what people actually have before reading the docs, so
      // sniff it rather than making them wrap it by hand.
      if (Array.isArray(parsed)) {
        const looksLikeIngredients = parsed.some(
          (x) => typeof x === 'object' && x !== null && 'purchase' in x,
        );
        bundle = looksLikeIngredients ? { ingredients: parsed } : { recipes: parsed };
      } else {
        bundle = parsed as ImportBundle;
      }
    } catch (err) {
      setError(`That is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    setBusy(true);
    try {
      setResult(await dryRunImport(bundle));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    const source = await file.text();
    setText(source.length > 200_000 ? `${source.slice(0, 200_000)}\n…` : source);
    await check(source);
  }

  async function commit(): Promise<void> {
    if (!result) return;
    setBusy(true);
    try {
      setCommitted(await commitImport(result));
    } finally {
      setBusy(false);
    }
  }

  async function download(): Promise<void> {
    const json = await exportLibrary();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `meal-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const unresolved = result ? summarizeUnresolved(result) : [];
  const unconvertible = result ? summarizeUnconvertible(result) : [];

  return (
    <Sheet title="Import & export" onClose={onClose}>
      {/* --- Export ------------------------------------------------------- */}
      <h3 className="section-title" style={{ marginTop: 0 }}>Back up</h3>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Your library as a JSON file. Since there is no sync yet, this is the only
        copy that exists outside this browser.
      </p>
      <button className="btn block" onClick={() => void download()}>Export library</button>

      {/* --- Import ------------------------------------------------------- */}
      <h3 className="section-title">Import</h3>
      <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
        Paste a bundle or pick a file. Nothing is written until you have seen what
        it will do.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e)}
      />

      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <button className="btn grow" onClick={() => fileInput.current?.click()}>Choose a file</button>
        <button
          className="btn grow"
          disabled={text.trim() === '' || busy}
          onClick={() => void check(text)}
        >
          {busy ? 'Checking…' : 'Check paste'}
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{\n  "recipes": [ … ]\n}'}
        rows={5}
        style={{
          width: '100%', padding: 10, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface)',
          fontFamily: 'ui-monospace, monospace', fontSize: 12.5, resize: 'vertical',
        }}
      />

      {error && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--danger)' }}>
          <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      {/* --- Validation report -------------------------------------------- */}
      {result && !committed && (
        <>
          <div className="stat-grid" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="v">{result.recipes.length}</div>
              <div className="k">recipes ready</div>
            </div>
            <div className="stat">
              <div className="v">{result.ingredients.length}</div>
              <div className="k">new ingredients</div>
            </div>
            <div className="stat">
              <div className="v" style={result.rejected.length > 0 ? { color: 'var(--danger)' } : undefined}>
                {result.rejected.length}
              </div>
              <div className="k">rejected</div>
            </div>
          </div>

          {unresolved.length > 0 && (
            <>
              <h3 className="section-title">Missing ingredients</h3>
              <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
                Most wanted first — a few of these usually explain most of the
                rejections. Add them, or add these spellings as aliases.
              </p>
              {unresolved.slice(0, 12).map(({ item, count }) => (
                <div className="card tight row between" key={item}>
                  <span className="grow truncate">{item}</span>
                  <span className="tiny faint">{count} ×</span>
                </div>
              ))}
              {unresolved.length > 12 && (
                <p className="tiny faint">…and {unresolved.length - 12} more.</p>
              )}
              <button
                className="btn block"
                style={{ marginTop: 8 }}
                onClick={() => {
                  const stubs = stubsFromResult(result);
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify({ ingredients: stubs }, null, 2)],
                      { type: 'application/json' }),
                  );
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'ingredient-stubs.json';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download {unresolved.length} ingredient stubs
              </button>
            </>
          )}

          {unconvertible.length > 0 && (
            <>
              <h3 className="section-title">Units that need defining</h3>
              <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
                These ingredients exist — they just need this unit added, not a new
                record.
              </p>
              {unconvertible.slice(0, 8).map((u) => (
                <div className="card tight small" key={`${u.ingredientId}-${u.unit}`}>
                  <strong>{u.ingredientId}</strong>
                  <span className="dim"> needs a “{u.unit}” unit ({u.count} ×)</span>
                </div>
              ))}
            </>
          )}

          {result.rejected.length > 0 && (
            <>
              <h3 className="section-title">Rejected recipes</h3>
              {result.rejected.slice(0, 8).map((r) => (
                <div className="card tight" key={r.id}>
                  <div className="strong small">{r.name}</div>
                  <div className="tiny dim">{r.reasons.slice(0, 3).join(' · ')}</div>
                </div>
              ))}
              {result.rejected.length > 8 && (
                <p className="tiny faint">…and {result.rejected.length - 8} more.</p>
              )}
            </>
          )}

          <button
            className="btn primary block"
            style={{ marginTop: 16 }}
            disabled={busy || (result.recipes.length === 0 && result.ingredients.length === 0)}
            onClick={() => void commit()}
          >
            {result.recipes.length === 0 && result.ingredients.length === 0
              ? 'Nothing to import'
              : `Import ${plural(result.recipes.length, 'recipe')}` +
                (result.ingredients.length > 0
                  ? ` and ${plural(result.ingredients.length, 'ingredient')}`
                  : '')}
          </button>

          {result.rejected.length > 0 && (
            <p className="tiny faint" style={{ marginTop: 6, textAlign: 'center' }}>
              Rejected recipes are skipped entirely — nothing is imported half-resolved.
            </p>
          )}
        </>
      )}

      {committed && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent)' }}>
          <div className="strong" style={{ color: 'var(--accent)' }}>Imported</div>
          <div className="small dim">
            {plural(committed.recipes, 'recipe')} and{' '}
            {plural(committed.ingredients, 'ingredient')} added. They are available
            to the planner straight away.
          </div>
        </div>
      )}
    </Sheet>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
