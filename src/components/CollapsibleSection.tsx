/**
 * A section of the This week screen that can be folded away.
 *
 * The screen is long by design — a summary, three kinds of meal, four grab bags,
 * the treats and the pantry review — and which parts are worth reading changes by
 * the day. Switching a section off in Settings is the permanent answer to that;
 * this is the temporary one, for the evening when you only want to see what you
 * are cooking and not the four bags underneath it.
 *
 * FOLDING IS NOT A SETTING, and the difference is why the state is kept here
 * rather than in the settings row. Settings sync, and a section you folded on the
 * phone folding itself on the laptop an hour later is the screen rearranging
 * itself behind your back. So it lives in `localStorage`: per device, which is
 * what a fold means.
 *
 * It does have to outlive the component, though. The tabs unmount their screens,
 * so component state alone would unfold everything on the way back from the
 * shopping list — which is the one trip you are most likely to make with the
 * meals folded up.
 *
 * The header is a button INSIDE the heading rather than a `<details>`/`<summary>`
 * pair. Most of these sections carry a Redraw button on the same line, and a
 * button inside a `<summary>` folds the section when you press it.
 */

import { useState } from 'react';

import { CaretIcon } from './icons';

const STORAGE_KEY = 'mealplanning.weekSections.closed';

/**
 * The folded sections, by id.
 *
 * Read on demand rather than held in a module-level cache. It is a handful of
 * strings read once per section per mount, and a cache would be one more thing
 * to keep in step with a second tab writing the same key.
 *
 * Every access is wrapped, because `localStorage` throws rather than answering
 * null when the browser is set to block site data. A screen that fails to render
 * because it could not remember a fold is a far worse bug than a fold forgotten.
 */
function readClosed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Read-modify-write, so folding one section does not unfold the others. */
function writeClosed(id: string, closed: boolean): void {
  try {
    const ids = readClosed();
    if (closed) ids.add(id);
    else ids.delete(id);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Not remembering the fold is survivable. Refusing to fold is not.
  }
}

export function CollapsibleSection({
  id,
  title,
  actions,
  closedNote,
  children,
}: {
  /**
   * Stable across renders and releases: this is the key the fold is stored
   * under, so renaming it silently unfolds the section for everyone.
   */
  readonly id: string;
  readonly title: string;
  /**
   * Controls belonging to the section rather than to the fold, e.g. Redraw.
   *
   * They go with the fold. A Redraw button left sitting on a folded heading is a
   * button whose entire effect is hidden — you press it, the bag changes, and
   * the screen says nothing. What is worth seeing while folded goes in
   * `closedNote` instead, where it cannot be pressed.
   */
  readonly actions?: React.ReactNode;
  /**
   * What the section is holding, said on the heading while it is folded.
   *
   * A folded section should still answer "is there anything in there" — folding
   * is for hiding detail, and a row of headings that could each be empty is a
   * row of headings you have to open one by one to find out.
   */
  readonly closedNote?: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(() => !readClosed().has(id));
  const bodyId = `week-section-${id.replace(/[^a-z0-9]+/gi, '-')}`;

  return (
    <section>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h2 className="section-title folds grow">
          <button
            type="button"
            className="section-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => {
              writeClosed(id, open);
              setOpen(!open);
            }}
          >
            <CaretIcon />
            <span className="grow">{title}</span>
            {!open && closedNote !== undefined && (
              <span className="fold-note">{closedNote}</span>
            )}
          </button>
        </h2>
        {open && actions}
      </div>

      {/*
        Hidden rather than unmounted. The contents are cheap — they are already
        in memory, and the plan is the state — while unmounting would throw away
        anything half-done inside a folded section, such as which page of the
        pantry you had reached.
      */}
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
