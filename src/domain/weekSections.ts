/**
 * What the This week screen is made of, and which setting switches each part on.
 *
 * The screen grew a section per feature — a summary, the meals, four grab bags,
 * the treat bag and the pantry review — and no household wants all of them. This
 * is that list, in the order they appear on the screen, so Settings can offer one
 * switch each without restating the screen's contents somewhere they can drift
 * out of step with it.
 *
 * THE SWITCHES ARE NOT ALL THE SAME KIND, and the difference matters enough to be
 * a field rather than a comment. Switching a bag off stops it being DRAWN:
 * nothing from that shelf reaches the plan, the shopping list or the spend.
 * Switching the summary, the meals or the pantry review off stops them being
 * SHOWN and nothing more — the meals are still planned and still shopped for.
 * Both are honest meanings of "off"; a screen that does not say which one it
 * means is not.
 *
 * FLAT BOOLEAN FIELDS, one per section, for the reason `GrabBagSettings` spells
 * out at length: settings sync per top-level field, so one nested object would be
 * a single clock over every section, and hiding the summary on the laptop would
 * quietly undo switching the treat bag off on the phone.
 */

import { type BagEnabledKey, GRAB_BAGS } from './grabbag';

/**
 * The sections whose switch is only about what is on screen.
 *
 * The bags are absent because they had switches before this existed — theirs
 * live in `GrabBagSettings` and `PlannerSettings`, where the draw can read them.
 */
export interface WeekSectionSettings {
  readonly summarySectionEnabled: boolean;
  readonly mealsSectionEnabled: boolean;
  readonly pantrySectionEnabled: boolean;
}

/** Every setting that switches a week-screen section on or off. */
export type WeekSectionEnabledKey =
  | keyof WeekSectionSettings
  | BagEnabledKey
  | 'treatBagEnabled';

/**
 * What switching a section off actually does — and, for the two kinds that change
 * the draw, which bag has to be refitted afterwards so the week on screen catches
 * up with the switch immediately rather than next Monday.
 */
export type SectionEffect = 'display' | 'grab-bag' | 'treat-bag';

export interface WeekSection {
  /** Stable key for the list. The bag id, where the section is a bag. */
  readonly id: string;
  readonly title: string;
  readonly enabledKey: WeekSectionEnabledKey;
  readonly effect: SectionEffect;
  /**
   * Anything true of this section and not of the others beside it.
   *
   * Absent on most of them on purpose. What "off" means is a property of the
   * `effect`, so the screen says it once per group rather than once per row —
   * five wordings of one sentence is five chances to word it differently.
   */
  readonly note?: string;
}

/** The sections of the This week screen, in the order they appear on it. */
export const WEEK_SECTIONS: readonly WeekSection[] = [
  {
    id: 'summary',
    title: 'Week summary',
    enabledKey: 'summarySectionEnabled',
    effect: 'display',
    note: 'Likely waste, estimated spend, and how much of the week is in season.',
  },
  {
    id: 'meals',
    title: 'Meals',
    enabledKey: 'mealsSectionEnabled',
    effect: 'display',
    note:
      'Hiding the meals does not stop them being planned or shopped for. To have ' +
      'fewer of them, or none, set their counts under Week shape.',
  },
  ...GRAB_BAGS.map((bag) => ({
    id: bag.id,
    title: bag.title,
    enabledKey: bag.enabledKey,
    effect: 'grab-bag' as const,
  })),
  {
    id: 'treats',
    title: 'Treat bag',
    enabledKey: 'treatBagEnabled',
    effect: 'treat-bag',
  },
  {
    id: 'pantry',
    title: 'Pantry review',
    enabledKey: 'pantrySectionEnabled',
    effect: 'display',
    note:
      "The stock check before a shop. Hiding it leaves the cupboard's own settings " +
      'alone, and anything already on the list stays on it.',
  },
];

/** The sections whose switch only changes the screen. */
export const DISPLAY_SECTIONS: readonly WeekSection[] =
  WEEK_SECTIONS.filter((s) => s.effect === 'display');

/** The sections whose switch decides whether the bag is drawn at all. */
export const DRAWN_SECTIONS: readonly WeekSection[] =
  WEEK_SECTIONS.filter((s) => s.effect !== 'display');
