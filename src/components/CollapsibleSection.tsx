/**
 * A section of a long screen that can be folded away.
 *
 * Three screens are long by design and for different reasons. This week is a
 * summary, three kinds of meal, four grab bags, the treats and the pantry review,
 * and which parts are worth reading changes by the day. Settings is thirty
 * controls of which you came to change one. Recipes carries a filter panel that
 * is in the way of the recipes the moment you have finished with it.
 *
 * Switching a week section off in Settings is the permanent answer to the first
 * of those; this is the temporary one, and the only answer to the other two.
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
 *
 * IDS ARE NAMESPACED BY SCREEN — `settings:pantry`, not `pantry` — because one
 * store serves all of them and This week already owns the short names. Two
 * screens sharing a key would fold each other's sections.
 */

import { useState } from 'react';

import { CaretIcon } from './icons';

/**
 * Named for the week screen because that is where folding started, and kept that
 * way now it is everywhere. Renaming it would be tidier and would forget every
 * fold every existing user has set, which is a worse trade than a stale name in
 * one private constant.
 */
const STORAGE_KEY = 'mealplanning.weekSections.closed';

/**
 * The folds the user has actually set, by id: true open, false folded.
 *
 * CHOICES, NOT STATE. A section absent from the record has never been touched and
 * falls to whatever default its screen asked for, which is what lets Settings
 * ship folded and This week ship open out of the same component. Storing the
 * resolved open/closed of every section instead would freeze today's defaults
 * into every device that has ever rendered one.
 *
 * Read on demand rather than held in a module-level cache. It is a handful of
 * keys read once per section per mount, and a cache would be one more thing to
 * keep in step with a second tab writing the same key.
 *
 * Every access is wrapped, because `localStorage` throws rather than answering
 * null when the browser is set to block site data. A screen that fails to render
 * because it could not remember a fold is a far worse bug than a fold forgotten.
 */
function readFolds(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);

    // The original format: a bare array of the ids that were folded, from before
    // any section defaulted to folded. Read rather than discarded, so upgrading
    // does not unfold the week screen for everyone who had folded it.
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed.filter((v): v is string => typeof v === 'string').map((id) => [id, false]),
      );
    }

    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [id, open] of Object.entries(parsed)) {
      if (typeof open === 'boolean') out[id] = open;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read-modify-write, so folding one section does not disturb the others. */
function writeFold(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readFolds(), [id]: open }));
  } catch {
    // Not remembering the fold is survivable. Refusing to fold is not.
  }
}

/**
 * One remembered fold: whether it is open, and the toggle that flips it.
 *
 * Exported because the fold and the heading it hangs on are separable, and
 * Settings needs them apart. Its bands fold too now, but a band is a caption in
 * louder type rather than a section heading — same memory, same caret, its own
 * markup. Everything about *where* a fold is stored stays in this file.
 */
export function useFold(id: string, defaultOpen: boolean): readonly [boolean, () => void] {
  const [open, setOpen] = useState(() => readFolds()[id] ?? defaultOpen);
  return [
    open,
    () => {
      writeFold(id, !open);
      setOpen(!open);
    },
  ];
}

export function CollapsibleSection({
  id,
  title,
  actions,
  closedNote,
  noteTone = 'quiet',
  defaultOpen = true,
  headingLevel = 2,
  children,
}: {
  /**
   * Stable across renders and releases: this is the key the fold is stored
   * under, so renaming it silently resets the section for everyone.
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
   * row of headings you have to open one by one to find out. On Settings it
   * carries the current value, which turns a folded screen into a legible index
   * of what the app is set to rather than a list of doors.
   */
  readonly closedNote?: string;
  /**
   * Whether the folded note is reporting something the user has changed.
   *
   * `quiet` for a note that merely describes what is in there — "4 drawn", "12
   * items". `active` for one saying that this folded section is doing something
   * to the screen below it, which is the recipe filters and nothing else so far:
   * a filter panel you cannot see, removing half the library, in the same grey
   * as every other heading, is the one way this pattern goes badly wrong.
   */
  readonly noteTone?: 'quiet' | 'active';
  /**
   * How the section starts before the user has ever folded it.
   *
   * This week defaults open: it is the screen's content, and a week you have to
   * unfold to read is not a week screen. Settings defaults folded: it is thirty
   * controls of which you came to change one, and the headings plus their
   * `closedNote` are a better first screen than the first two controls are.
   */
  readonly defaultOpen?: boolean;
  /**
   * Where the section sits in the document outline.
   *
   * Two by default, which is what a section directly under the screen's `h1` is.
   * Settings passes three, because its sections now live inside bands that fold
   * and so are headings themselves — leaving both at `h2` would tell a screen
   * reader that "Your week" and "Week shape" are peers when one contains the
   * other.
   */
  readonly headingLevel?: 2 | 3;
  readonly children: React.ReactNode;
}): JSX.Element {
  const [open, toggle] = useFold(id, defaultOpen);
  const bodyId = `section-${id.replace(/[^a-z0-9]+/gi, '-')}`;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <section>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <Heading className="section-title folds grow">
          <button
            type="button"
            className="section-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <CaretIcon />
            <span className="grow">{title}</span>
            {!open && closedNote !== undefined && (
              <span className={`fold-note${noteTone === 'active' ? ' on' : ''}`}>
                {closedNote}
              </span>
            )}
          </button>
        </Heading>
        {open && actions}
      </div>

      {/*
        Hidden rather than unmounted. The contents are cheap — they are already
        in memory, and the database is the state — while unmounting would throw
        away anything half-done inside a folded section, such as which page of
        the pantry you had reached or the ingredient search you had typed.
      */}
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
