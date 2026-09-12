import { useEffect, useMemo, useRef, useState } from 'react';

import type { AppState } from '../state/useAppState';
import { Sheet } from '../components/Sheet';
import { commitImport, updateIngredients } from '../db/repository';
import {
  importBundle, summarizeUnconvertible, summarizeUnresolved,
  type ImportIssue, type ImportResult, type RawIngredient,
} from '../domain/import/importer';
import {
  ORIGIN_LABELS, draftToRawRecipe, emptyDraft, uniqueRecipeId, type RecipeDraft,
} from '../domain/import/draft';
import { draftsFromHtml, draftsFromPaste } from '../domain/import/parseRecipeHtml';
import { parseRecipeText } from '../domain/import/parseRecipeText';
import { hasLocalOcrAssets, recogniseText, tidyOcrText, type OcrProgress } from '../domain/import/ocr';
import { stubFor } from '../domain/import/stubs';
import { suggestIngredients, withAlias, type Suggestion } from '../domain/import/suggest';
import type { Id, Ingredient, IngredientCategory, MealType } from '../domain/types';

/**
 * Capturing one recipe from a link, a photo, or a block of text.
 *
 * This is the counterpart to `ImportSheet`, which handles a finished JSON bundle.
 * That path assumes the data has already been made correct somewhere else. This
 * one assumes the opposite: everything arriving here was extracted from a web
 * page, a photograph or a paste, and is therefore wrong somewhere.
 *
 * So the review screen is the feature, not the parsers. All three sources
 * converge on an editable draft that shows, line by line, what resolved and what
 * did not — and nothing is written until a human has looked at it. The parsers
 * only have to be good enough to make that review quick.
 *
 * Crucially, capture uses the SAME importer as a bulk file. There is no second,
 * laxer way into the library: an ingredient that cannot be resolved to real
 * grams rejects the recipe here exactly as it would in a bundle, because the
 * planner treats grams as ground truth and a recipe with a hole in it will
 * confidently send you shopping for the wrong food.
 */

type Mode = 'choose' | 'link' | 'photo' | 'text';

const CATEGORIES: readonly IngredientCategory[] = [
  'produce', 'meat', 'seafood', 'dairy', 'bakery', 'grain', 'legume', 'canned',
  'frozen', 'spice', 'condiment', 'oil', 'baking', 'beverage', 'other',
];

const MEAL_TYPES: ReadonlyArray<{ value: MealType; label: string }> = [
  { value: 'full', label: 'Full meal' },
  { value: 'light', label: 'Light meal' },
  { value: 'snack', label: 'Snack' },
];

/** A camera is worth offering on a phone and confusing on a laptop. */
function hasCamera(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function AddRecipeSheet({
  state,
  onClose,
}: {
  state: AppState;
  onClose: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('choose');
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [candidates, setCandidates] = useState<RecipeDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Ingredients the user has chosen to create as part of this import, keyed by
  // the unresolved name that prompted them, plus their hand-edited fields.
  const [creating, setCreating] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Partial<RawIngredient>>>({});

  // Count units being defined on ingredients that already exist, keyed
  // `ingredientId|unit`. These PATCH a record rather than adding one.
  const [countUnits, setCountUnits] = useState<Record<string, number>>({});

  // Spellings being taught to an ingredient that already exists, as
  // unresolved name -> ingredient id. Also a patch, never a new record.
  const [aliases, setAliases] = useState<Record<string, Id>>({});

  function reset(): void {
    setDraft(null);
    setCandidates(null);
    setError(null);
    setCreating(new Set());
    setEdits({});
    setCountUnits({});
    setAliases({});
  }

  function accept(found: readonly RecipeDraft[], emptyMessage: string): void {
    reset();
    if (found.length === 0) {
      setError(emptyMessage);
      return;
    }
    if (found.length === 1) setDraft(found[0]);
    else setCandidates([...found]);
  }

  // -------------------------------------------------------------------------
  // Validation — recomputed from the draft on every keystroke
  // -------------------------------------------------------------------------

  const recipeId = useMemo(
    () => uniqueRecipeId(draft?.name ?? '', new Set(state.recipes.keys())),
    [draft?.name, state.recipes],
  );

  /** Count units being defined, grouped by the ingredient they belong to. */
  const countUnitAdditions = useMemo(() => {
    const additions = new Map<Id, Record<string, number>>();
    for (const [key, grams] of Object.entries(countUnits)) {
      if (!(grams > 0)) continue;
      const [ingredientId, unit] = key.split('|');
      const forIngredient = additions.get(ingredientId) ?? {};
      forIngredient[unit] = grams;
      additions.set(ingredientId, forIngredient);
    }
    return additions;
  }, [countUnits]);

  /** Spellings being taught to an existing ingredient, grouped by that record. */
  const aliasAdditions = useMemo(() => {
    const additions = new Map<Id, string[]>();
    for (const [spelling, ingredientId] of Object.entries(aliases)) {
      additions.set(ingredientId, [...(additions.get(ingredientId) ?? []), spelling]);
    }
    return additions;
  }, [aliases]);

  /**
   * The library as the importer should see it: existing records plus whatever
   * the user is correcting on them.
   *
   * Both corrections here patch records rather than adding them, which is the
   * whole point. A new spelling becomes an alias on the food that already
   * exists, and a new unit becomes a `countUnits` entry on it — because creating
   * a second record instead would split one food into two the optimizer never
   * overlaps, permanently and invisibly.
   */
  const { patchedLibrary, changedIngredients } = useMemo(() => {
    const changed: Ingredient[] = [];
    const library = [...state.ingredients.values()].map((ing) => {
      const units = countUnitAdditions.get(ing.id);
      const spellings = aliasAdditions.get(ing.id);
      if (!units && !spellings) return ing;

      let patched: Ingredient = units
        ? { ...ing, countUnits: { ...ing.countUnits, ...units } }
        : ing;
      for (const spelling of spellings ?? []) patched = withAlias(patched, spelling);

      changed.push(patched);
      return patched;
    });
    return { patchedLibrary: library, changedIngredients: changed };
  }, [state.ingredients, countUnitAdditions, aliasAdditions]);

  /**
   * The ingredients this import would create.
   *
   * Count-unit definitions are applied here too, not only to the library. A
   * stub generated for "coriander" has no `handful` either, so without this the
   * user fills in a weight for an ingredient being created in this same import
   * and nothing happens — the error never clears and the screen is a dead end.
   */
  const newIngredients = useMemo(
    () => [...creating].map((item) => {
      const base = { ...stubFor(item), ...edits[item] } as RawIngredient;
      const extra = countUnitAdditions.get(base.id);
      return extra ? { ...base, countUnits: { ...base.countUnits, ...extra } } : base;
    }),
    [creating, edits, countUnitAdditions],
  );

  const result = useMemo<ImportResult | null>(() => {
    if (!draft) return null;
    const raw = draftToRawRecipe(draft, recipeId);
    if (raw.ingredients.length === 0) return null;
    return importBundle({ ingredients: newIngredients, recipes: [raw] }, patchedLibrary);
  }, [draft, recipeId, newIngredients, patchedLibrary]);

  /** Issues attached to a specific ingredient line, so each row explains itself. */
  const issuesByLine = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of result?.issues ?? []) {
      const match = /\.ingredients\[(\d+)\]$/.exec(issue.path);
      if (!match) continue;
      const index = Number(match[1]);
      map.set(index, [...(map.get(index) ?? []), issue]);
    }
    return map;
  }, [result]);

  const unresolved = result ? summarizeUnresolved(result) : [];
  const unconvertible = result ? summarizeUnconvertible(result) : [];
  const ready = result !== null && result.recipes.length === 1;

  async function commit(): Promise<void> {
    if (!result || !ready) return;
    setBusy(true);
    try {
      // Patches to existing records go first. If the second write failed, an
      // ingredient with a newly defined count unit is harmless on its own; a
      // recipe referencing a unit that was never saved would not be.
      await updateIngredients(changedIngredients);
      await commitImport(result);
      setCommitted(result.recipes[0].name);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------

  if (committed) {
    return (
      <Sheet title="Recipe added" onClose={onClose}>
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div className="strong" style={{ color: 'var(--accent)' }}>{committed}</div>
          <div className="small dim">
            Added to your library and available to the planner straight away.
          </div>
        </div>
        <button
          className="btn block"
          style={{ marginTop: 10 }}
          onClick={() => { setCommitted(null); reset(); setMode('choose'); }}
        >
          Add another
        </button>
        <button className="btn primary block" style={{ marginTop: 8 }} onClick={onClose}>
          Done
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title="Add a recipe" onClose={onClose}>
      {draft === null && candidates === null && (
        <SourcePicker
          mode={mode}
          setMode={setMode}
          busy={busy}
          setBusy={setBusy}
          error={error}
          setError={setError}
          onDrafts={accept}
          onBlank={() => { reset(); setDraft(emptyDraft()); }}
        />
      )}

      {candidates !== null && (
        <>
          <h3 className="section-title" style={{ marginTop: 0 }}>
            {candidates.length} recipes on that page
          </h3>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            Pick the one you want. Round-up posts publish several, and guessing
            for you would be wrong more often than not.
          </p>
          {candidates.map((candidate, i) => (
            <button
              key={`${candidate.name}-${i}`}
              className="card"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => { setCandidates(null); setDraft(candidate); }}
            >
              <div className="strong">{candidate.name || '(untitled)'}</div>
              <div className="tiny dim" style={{ marginTop: 3 }}>
                {candidate.ingredientLines.length} ingredients · {candidate.steps.length} steps
              </div>
            </button>
          ))}
          <button className="btn block" style={{ marginTop: 8 }} onClick={reset}>
            Back
          </button>
        </>
      )}

      {draft !== null && result !== null && (
        <Review
          draft={draft}
          setDraft={setDraft}
          result={result}
          issuesByLine={issuesByLine}
          unresolved={unresolved}
          unconvertible={unconvertible}
          ingredients={state.ingredients}
          newIngredients={newIngredients}
          aliases={aliases}
          onSetAlias={(spelling, ingredientId) => {
            // Taking a suggestion replaces creating a record: the spelling is
            // taught to the ingredient that already exists instead.
            setCreating((previous) => {
              const next = new Set(previous);
              next.delete(spelling);
              return next;
            });
            setAliases((previous) => ({ ...previous, [spelling]: ingredientId }));
          }}
          onUndoAlias={(spelling) => setAliases(({ [spelling]: _removed, ...rest }) => rest)}
          creating={creating}
          setCreating={setCreating}
          edits={edits}
          setEdits={setEdits}
          countUnits={countUnits}
          setCountUnits={setCountUnits}
          ready={ready}
          busy={busy}
          onCommit={() => void commit()}
          onBack={() => { reset(); setMode('choose'); }}
        />
      )}

      {draft !== null && result === null && (
        <>
          <p className="small dim">
            This draft has no ingredient lines yet. Add at least one to see what it
            will import as.
          </p>
          <Lines
            lines={draft.ingredientLines}
            issuesByLine={new Map()}
            onChange={(lines) => setDraft({ ...draft, ingredientLines: lines })}
          />
          <button className="btn block" style={{ marginTop: 8 }} onClick={() => { reset(); setMode('choose'); }}>
            Start over
          </button>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Choosing a source
// ---------------------------------------------------------------------------

function SourcePicker({
  mode, setMode, busy, setBusy, error, setError, onDrafts, onBlank,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  onDrafts: (drafts: readonly RecipeDraft[], emptyMessage: string) => void;
  onBlank: () => void;
}): JSX.Element {
  const [url, setUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [ocr, setOcr] = useState<OcrProgress | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  // This component unmounts the moment a draft is accepted, which on the photo
  // route is every successful import — so without this the blob outlives the
  // screen that showed it, once per photo, for as long as the tab is open.
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);
  const [confidence, setConfidence] = useState<number | null>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  async function onImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setConfidence(null);
    setPhotoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });

    setBusy(true);
    try {
      const local = await hasLocalOcrAssets();
      const outcome = await recogniseText(file, setOcr);
      setConfidence(outcome.confidence);

      const text = tidyOcrText(outcome.text);
      if (text.trim() === '') {
        setError(
          'No text could be read from that photo. A flat, evenly lit page fills ' +
          'the frame best — or type the recipe in instead.',
        );
        return;
      }

      const draft = parseRecipeText(text, { origin: 'photo', fallbackTitle: titleFrom(file.name) });
      if (!local) {
        draft.notes.push('The text reader was downloaded from the Tesseract project rather than served by this app.');
      }
      draft.notes.push(
        `Read by OCR at ${Math.round(outcome.confidence)}% average confidence — check every ` +
        'quantity against the photo before importing.',
      );
      onDrafts([draft], '');
    } catch (err) {
      setError(
        `The text reader could not start — ${err instanceof Error ? err.message : String(err)}. ` +
        'You can still paste or type the recipe.',
      );
    } finally {
      setBusy(false);
      setOcr(null);
    }
  }

  return (
    <>
      <div className="chips" style={{ marginBottom: 12 }}>
        {([['link', 'From a link'], ['photo', 'From a photo'], ['text', 'From text']] as const).map(
          ([value, label]) => (
            <button
              key={value}
              className="chip"
              aria-pressed={mode === value}
              onClick={() => { setMode(value); setError(null); }}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {mode === 'choose' && (
        <p className="small dim">
          Pick where the recipe is coming from. Whichever you choose, you get to
          check what was read before anything is saved.
        </p>
      )}

      {/* --- Link ---------------------------------------------------------- */}
      {mode === 'link' && (
        <>
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            A browser is not allowed to fetch another site's pages, and routing
            them through a proxy would mean sending every recipe you read to
            somebody else's server. So: open the page, select all, copy, and paste
            it here. Most sites publish their recipes as structured data, which is
            read exactly as the author entered it.
          </p>

          <label className="tiny faint" htmlFor="capture-url">Page address — recorded as the source</label>
          <input
            id="capture-url"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ marginBottom: 8 }}
          />

          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste the whole page here"
            rows={6}
            style={pasteStyle}
          />
          <button
            className="btn primary block"
            style={{ marginTop: 8 }}
            disabled={pasted.trim() === '' || busy}
            onClick={() => onDrafts(
              draftsFromHtml(pasted, url.trim() || undefined),
              'No recipe could be found in that page. If you copied only part of it, try ' +
              'selecting the whole page — or paste just the ingredients as text instead.',
            )}
          >
            Read the page
          </button>
        </>
      )}

      {/* --- Photo --------------------------------------------------------- */}
      {mode === 'photo' && (
        <>
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            A cookbook page, a recipe card, a screenshot. The text is read on this
            device — the photo is never uploaded anywhere. Lay the page flat and
            fill the frame; anything the reader mangles is flagged rather than
            guessed at.
          </p>

          <input
            ref={gallery}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void onImage(e.target.files?.[0])}
          />
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => void onImage(e.target.files?.[0])}
          />

          <div className="row" style={{ gap: 8 }}>
            {hasCamera() && (
              <button className="btn grow" disabled={busy} onClick={() => camera.current?.click()}>
                Take a photo
              </button>
            )}
            <button className="btn grow" disabled={busy} onClick={() => gallery.current?.click()}>
              {hasCamera() ? 'Choose a photo' : 'Choose an image'}
            </button>
          </div>

          {photoUrl && (
            <img
              src={photoUrl}
              alt="The photo being read"
              style={{
                width: '100%', marginTop: 10, borderRadius: 8,
                border: '1px solid var(--border)', maxHeight: 220, objectFit: 'cover',
              }}
            />
          )}

          {ocr && (
            <div className="card tight" style={{ marginTop: 10 }}>
              <div className="small">{ocr.message}</div>
              <div className="progress">
                <div style={{ width: `${Math.round(ocr.ratio * 100)}%` }} />
              </div>
            </div>
          )}

          {confidence !== null && !busy && (
            <p className="tiny faint" style={{ marginTop: 8 }}>
              Read at {Math.round(confidence)}% average confidence.
              {confidence < 75 && ' That is low — a flatter, better-lit photo will read far better.'}
            </p>
          )}
        </>
      )}

      {/* --- Text ---------------------------------------------------------- */}
      {mode === 'text' && (
        <>
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Paste it however it is written — a title, the ingredients one per
            line, then the method. Headings help, but it copes without them.
          </p>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'Lemon Garlic Chicken\nServes 4\n\nIngredients\n800 g chicken thighs\n4 cloves garlic, minced\n…'}
            rows={8}
            style={pasteStyle}
          />
          <button
            className="btn primary block"
            style={{ marginTop: 8 }}
            disabled={pasted.trim() === '' || busy}
            onClick={() => onDrafts(
              draftsFromPaste(pasted),
              'No ingredient list could be found in that text.',
            )}
          >
            Read it
          </button>
          <button className="btn block ghost" style={{ marginTop: 8 }} onClick={onBlank}>
            Or start from a blank recipe
          </button>
        </>
      )}

      {error && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--danger)' }}>
          <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}
    </>
  );
}

const pasteStyle: React.CSSProperties = {
  width: '100%', padding: 10, borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  fontFamily: 'ui-monospace, monospace', fontSize: 12.5, resize: 'vertical',
};

function titleFrom(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function Review({
  draft, setDraft, result, issuesByLine, unresolved, unconvertible, ingredients, newIngredients,
  aliases, onSetAlias, onUndoAlias,
  creating, setCreating, edits, setEdits, countUnits, setCountUnits,
  ready, busy, onCommit, onBack,
}: {
  draft: RecipeDraft;
  setDraft: (draft: RecipeDraft) => void;
  result: ImportResult;
  issuesByLine: ReadonlyMap<number, ImportIssue[]>;
  unresolved: ReadonlyArray<{ item: string; count: number }>;
  unconvertible: ReadonlyArray<{ ingredientId: string; unit: string; count: number }>;
  ingredients: ReadonlyMap<Id, Ingredient>;
  /** Ingredients this import will create, so a unit card can name them too. */
  newIngredients: readonly RawIngredient[];
  /** Spellings being taught to existing ingredients, as spelling -> id. */
  aliases: Record<string, Id>;
  onSetAlias: (spelling: string, ingredientId: Id) => void;
  onUndoAlias: (spelling: string) => void;
  creating: ReadonlySet<string>;
  setCreating: (update: (previous: Set<string>) => Set<string>) => void;
  edits: Record<string, Partial<RawIngredient>>;
  setEdits: (update: (previous: Record<string, Partial<RawIngredient>>) => Record<string, Partial<RawIngredient>>) => void;
  countUnits: Record<string, number>;
  setCountUnits: (update: (previous: Record<string, number>) => Record<string, number>) => void;
  ready: boolean;
  busy: boolean;
  onCommit: () => void;
  onBack: () => void;
}): JSX.Element {
  const recipe = result.recipes[0];

  /**
   * Ingredients this import will create: the ones still unresolved, plus the ones
   * already switched on.
   *
   * Both halves are needed. Switching one on resolves it, so listing only the
   * unresolved would make the card vanish at the exact moment it became worth
   * reading — taking the pack size and `divisible` fields with it, which are the
   * two the user was being asked to check.
   */
  const toCreate = useMemo(
    () => [...new Set([...unresolved.map((u) => u.item), ...creating])],
    [unresolved, creating],
  );

  return (
    <>
      <p className="tiny faint" style={{ margin: '0 0 10px' }}>
        Read from {ORIGIN_LABELS[draft.origin]}. Everything below is editable, and
        nothing is saved until you say so.
      </p>

      {draft.notes.length > 0 && (
        <div className="card tight" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}>
          <div className="tiny strong">What was assumed</div>
          {draft.notes.map((note) => (
            <div className="tiny dim" key={note} style={{ marginTop: 3 }}>· {note}</div>
          ))}
        </div>
      )}

      {/* --- The recipe itself --------------------------------------------- */}
      <h3 className="section-title">Recipe</h3>
      <input
        type="text"
        placeholder="Recipe name"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <label className="grow tiny faint">
          Meal type
          <select
            value={draft.mealType}
            onChange={(e) => setDraft({ ...draft, mealType: e.target.value as MealType })}
            style={{ width: '100%' }}
          >
            {MEAL_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="tiny faint" style={{ width: 90 }}>
          Servings
          <input
            type="number"
            min={1}
            value={draft.baseServings}
            onChange={(e) => setDraft({ ...draft, baseServings: Math.max(1, Number(e.target.value) || 1) })}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <label className="grow tiny faint">
          Prep minutes
          <input
            type="number"
            min={0}
            value={draft.prepMinutes}
            onChange={(e) => setDraft({ ...draft, prepMinutes: Math.max(0, Number(e.target.value) || 0) })}
            style={{ width: '100%' }}
          />
        </label>
        <label className="grow tiny faint">
          Cook minutes
          <input
            type="number"
            min={0}
            value={draft.cookMinutes}
            onChange={(e) => setDraft({ ...draft, cookMinutes: Math.max(0, Number(e.target.value) || 0) })}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      {/* --- Ingredients ---------------------------------------------------- */}
      <h3 className="section-title">
        Ingredients
        <span className="tiny faint" style={{ fontWeight: 400 }}>
          {' '}· {recipe
            ? `all ${recipe.ingredients.length} resolved`
            : `${issuesByLine.size} ${issuesByLine.size === 1 ? 'needs' : 'need'} attention`}
        </span>
      </h3>
      <Lines
        lines={draft.ingredientLines}
        issuesByLine={issuesByLine}
        onChange={(lines) => setDraft({ ...draft, ingredientLines: lines })}
      />

      {/* --- Ingredients that do not exist yet ------------------------------ */}
      {toCreate.length > 0 && (
        <>
          <h3 className="section-title">New to your ingredient list</h3>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            Add each one, or edit the line above to a name you already have. The
            pack size and whether it is sold loose are the two numbers that decide
            how much waste the planner thinks a recipe causes, so they are worth a
            second of thought — the rest can be approximate.
          </p>
          {toCreate.map((item) => (
            <NewIngredient
              key={item}
              item={item}
              suggestions={suggestIngredients(item, ingredients.values())}
              onAlias={(ingredientId) => onSetAlias(item, ingredientId)}
              enabled={creating.has(item)}
              edit={edits[item] ?? {}}
              onToggle={(on) => setCreating((previous) => {
                const next = new Set(previous);
                if (on) next.add(item); else next.delete(item);
                return next;
              })}
              onEdit={(patch) => setEdits((previous) => ({
                ...previous,
                [item]: { ...previous[item], ...patch },
              }))}
            />
          ))}
        </>
      )}

      {/* --- Spellings taught to existing ingredients ----------------------- */}
      {Object.keys(aliases).length > 0 && (
        <>
          <h3 className="section-title">Spellings learned</h3>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            Saved onto the ingredient, so these resolve on their own from now on.
          </p>
          {Object.entries(aliases).map(([spelling, ingredientId]) => (
            <div className="card tight row between" key={spelling} style={{ alignItems: 'center' }}>
              <span className="grow truncate small">
                “{spelling}” → {ingredients.get(ingredientId)?.name ?? ingredientId}
              </span>
              <button className="btn small ghost" onClick={() => onUndoAlias(spelling)}>
                Undo
              </button>
            </div>
          ))}
        </>
      )}

      {/* --- Units an existing ingredient does not have --------------------- */}
      {unconvertible.length > 0 && (
        <>
          <h3 className="section-title">Units that need a weight</h3>
          <p className="tiny faint" style={{ margin: '-4px 0 8px' }}>
            The ingredient is fine — it just has no weight recorded for the unit
            this recipe uses. Fill it in here rather than adding a second
            ingredient, which would split one food into two the planner never
            treats as the same thing.
          </p>
          {unconvertible.map(({ ingredientId, unit }) => {
            const key = `${ingredientId}|${unit}`;
            // The ingredient is either already in the library or being created by
            // this same import, and the two want different words: one is a
            // permanent change to existing data, the other is just filling in a
            // blank on a record that does not exist yet.
            const existing = ingredients.get(ingredientId);
            const pending = newIngredients.find((candidate) => candidate.id === ingredientId);
            const name = existing?.name ?? pending?.name ?? ingredientId;

            return (
              <div className="card tight" key={key}>
                <div className="small">
                  {/* "1 each of Salmon fillet" is not a sentence anybody says. */}
                  {unit === 'each'
                    ? <>How much does <strong>one {name}</strong> weigh?</>
                    : <>How much does <strong>1 {unit}</strong> of {name} weigh?</>}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
                  <input
                    type="number"
                    min={0}
                    placeholder="grams"
                    value={countUnits[key] ?? ''}
                    onChange={(e) => setCountUnits((previous) => ({
                      ...previous,
                      [key]: Number(e.target.value) || 0,
                    }))}
                    style={{ width: 110 }}
                  />
                  <span className="tiny faint">
                    grams — {existing
                      ? `saved onto ${name} for good`
                      : `recorded on ${name} as it is added`}
                  </span>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* --- Rejections not covered above ---------------------------------- */}
      {result.rejected.length > 0 && issuesByLine.size === 0 && (
        <div className="card tight" style={{ borderColor: 'var(--danger)' }}>
          <div className="tiny strong" style={{ color: 'var(--danger)' }}>Not ready yet</div>
          {result.rejected[0].reasons.map((reason) => (
            <div className="tiny dim" key={reason} style={{ marginTop: 3 }}>· {reason}</div>
          ))}
        </div>
      )}

      {/* --- Method --------------------------------------------------------- */}
      <h3 className="section-title">Method</h3>
      <textarea
        value={draft.steps.join('\n')}
        onChange={(e) => setDraft({ ...draft, steps: e.target.value.split('\n') })}
        placeholder="One step per line"
        rows={5}
        style={{ ...pasteStyle, fontFamily: 'inherit', fontSize: 13.5 }}
      />

      {draft.source?.url && (
        <p className="tiny faint truncate" style={{ marginTop: 8 }}>
          Source: {draft.source.url}
        </p>
      )}

      <button
        className="btn primary block"
        style={{ marginTop: 16 }}
        disabled={!ready || busy || draft.name.trim() === ''}
        onClick={onCommit}
      >
        {draft.name.trim() === ''
          ? 'Give it a name first'
          : ready
            ? `Add ${recipe.ingredients.length} ingredients to your library`
            : 'Fix the flagged lines to continue'}
      </button>
      <button className="btn block" style={{ marginTop: 8 }} onClick={onBack}>
        Start over
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The ingredient lines, one editable row each, with its own verdict beside it.
 *
 * Per-row rather than one big text area because the whole point of the review is
 * that a failure is attached to the line that caused it. A list of errors above a
 * block of text makes the user do the matching up themselves, which is exactly
 * the work this screen exists to remove.
 */
function Lines({
  lines,
  issuesByLine,
  onChange,
}: {
  lines: readonly string[];
  issuesByLine: ReadonlyMap<number, ImportIssue[]>;
  onChange: (lines: string[]) => void;
}): JSX.Element {
  function replace(index: number, value: string): void {
    const next = [...lines];
    next[index] = value;
    onChange(next);
  }

  return (
    <>
      {lines.map((line, index) => {
        const issues = issuesByLine.get(index) ?? [];
        const errors = issues.filter((i) => i.severity === 'error');
        const warnings = issues.filter((i) => i.severity === 'warning');
        const colour = errors.length > 0 ? 'var(--danger)' : warnings.length > 0 ? 'var(--warn)' : undefined;

        return (
          <div key={index} style={{ marginBottom: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                value={line}
                aria-label={`Ingredient line ${index + 1}`}
                aria-invalid={errors.length > 0}
                onChange={(e) => replace(index, e.target.value)}
                className="grow"
                style={{ borderColor: colour, flex: 1, minWidth: 0 }}
              />
              <button
                className="btn small ghost"
                aria-label={`Remove line ${index + 1}`}
                onClick={() => onChange(lines.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
            {[...errors, ...warnings].map((issue) => (
              <div
                className="tiny"
                key={issue.message}
                style={{ color: issue.severity === 'error' ? 'var(--danger)' : 'var(--warn)', marginTop: 2 }}
              >
                {issue.message}
              </div>
            ))}
          </div>
        );
      })}
      <button className="btn small block" onClick={() => onChange([...lines, ''])}>
        Add a line
      </button>
    </>
  );
}

/**
 * One missing ingredient, pre-filled from a stub and waiting to be checked.
 *
 * Collapsed to a single row until it is switched on, because a capture from the
 * web routinely turns up five or six of these and six expanded forms is a wall
 * nobody reads. The two fields that matter are on the face of the expanded card;
 * the rest keep the stub's guesses.
 */
function NewIngredient({
  item, suggestions, enabled, edit, onAlias, onToggle, onEdit,
}: {
  item: string;
  suggestions: readonly Suggestion[];
  enabled: boolean;
  edit: Partial<RawIngredient>;
  onAlias: (ingredientId: Id) => void;
  onToggle: (on: boolean) => void;
  onEdit: (patch: Partial<RawIngredient>) => void;
}): JSX.Element {
  const stub = useMemo(() => stubFor(item), [item]);
  const value = { ...stub, ...edit } as RawIngredient;

  return (
    <div className="card tight" style={enabled ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="row between" style={{ alignItems: 'center' }}>
        <span className="grow truncate small">{value.name}</span>
        <button
          className={enabled ? 'btn small primary' : 'btn small'}
          aria-pressed={enabled}
          onClick={() => onToggle(!enabled)}
        >
          {enabled ? 'Adding' : 'Add as new'}
        </button>
      </div>

      {/* Offered BEFORE the create form, and left visible while it is open.
          A recipe writing "salmon fillets" when the library says "Salmon fillet"
          is the most common failure here, and creating the second record is both
          the easier action and the wrong one — it splits one food into two that
          the planner will never overlap, quietly and permanently. */}
      {!enabled && suggestions.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="tiny faint">Already in your list — did you mean?</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.ingredient.id}
                className="chip"
                onClick={() => onAlias(suggestion.ingredient.id)}
              >
                {suggestion.ingredient.name}
              </button>
            ))}
          </div>
          <div className="tiny faint" style={{ marginTop: 4 }}>
            Picking one records “{item}” as another name for it, so it resolves by
            itself next time.
          </div>
        </div>
      )}

      {enabled && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <label className="grow tiny faint">
              Category
              <select
                value={value.category}
                onChange={(e) => onEdit({ category: e.target.value as IngredientCategory })}
                style={{ width: '100%' }}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="tiny faint" style={{ width: 110 }}>
              Smallest pack (g)
              <input
                type="number"
                min={1}
                value={value.purchase.gramsPerPack}
                onChange={(e) => onEdit({
                  purchase: { ...value.purchase, gramsPerPack: Math.max(1, Number(e.target.value) || 1) },
                })}
                style={{ width: '100%' }}
              />
            </label>
          </div>

          <label className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={value.purchase.divisible}
              onChange={(e) => onEdit({
                purchase: { ...value.purchase, divisible: e.target.checked },
              })}
            />
            <span className="tiny">
              Sold loose — you can buy exactly what a recipe needs
            </span>
          </label>

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <label className="grow tiny faint">
              Cost per kg
              <input
                type="number"
                min={0}
                step="0.5"
                value={value.purchase.costPerKg}
                onChange={(e) => onEdit({
                  purchase: { ...value.purchase, costPerKg: Math.max(0, Number(e.target.value) || 0) },
                })}
                style={{ width: '100%' }}
              />
            </label>
            <label className="grow tiny faint">
              Keeps for (days)
              <input
                type="number"
                min={1}
                value={value.shelfLifeDays}
                onChange={(e) => onEdit({ shelfLifeDays: Math.max(1, Number(e.target.value) || 1) })}
                style={{ width: '100%' }}
              />
            </label>
          </div>

          <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
            These start as guesses from the name. The pack size and whether it is
            sold loose drive the waste model; nutrition and seasonality are left
            empty and can be filled in later from the import file.
          </p>
        </div>
      )}
    </div>
  );
}
