/**
 * Week rules — "at least three meals under 30 minutes", "two pasta nights",
 * "something with the halloumi in the fridge".
 *
 * A DIFFERENT KIND OF CONSTRAINT from everything in `filters.ts`, and that is the
 * whole reason this file exists. A filter is a fact about one recipe: it is
 * vegetarian, it takes 25 minutes, it contains no wheat. A rule is a fact about
 * the WEEK — three of them, not all of them — and no per-recipe predicate can
 * express that. "Every meal under 30 minutes" is a filter and gives you a week of
 * stir-fries; "three meals under 30 minutes" is a rule and gives you three quick
 * nights and four you can take your time over. The second is what people mean.
 *
 * So a rule is a filter PLUS A COUNT, and the filter half is the same
 * `RecipeFilter` the library browser uses — the subjects below build one each.
 * Nothing here re-implements "is this recipe quick"; it asks the same question
 * the Recipes tab asks, so the two can never drift.
 *
 * HOW IT REACHES THE PLANNER. Not as a hard filter, because a hard filter cannot
 * count, and not by post-hoc repair, because swapping a meal in afterwards undoes
 * the overlap the optimizer just spent its whole search finding. It goes in as a
 * term in the objective: every meal a rule is still short costs `weights.rules`,
 * set high enough that the search will pay almost any amount of waste to satisfy
 * a rule, and low enough that an impossible rule degrades into a plan with one
 * unmet rule rather than no plan at all. The search then satisfies rules the same
 * way it does everything else, with the overlap still working around them.
 *
 * WHICH MEALS A RULE COVERS IS PART OF THE RULE, and it defaults to full meals in
 * the UI for a reason worth writing down: almost every snack in the library is
 * already under 30 minutes, so a "3 meals under 30 minutes" rule that counted
 * snacks would be satisfied before it was written, by a week that still has four
 * hour-long dinners in it. A rule nobody can fail is a rule nobody should be
 * offered.
 */

import type { FilterContext, RecipeFilter } from './filters';
import { testRecipe } from './filters';
import type { CuisineRegionId, DishTypeId } from './taxonomy';
import { CUISINE_REGION_LABELS, DISH_TYPE_PHRASES } from './taxonomy';
import type { Id, MealType, PlanSlot, Recipe } from './types';

export type RuleComparison = 'at-least' | 'at-most';

export type RuleSubjectId =
  | 'quick' | 'dish-type' | 'region' | 'ingredient' | 'tag'
  | 'high-protein' | 'in-season' | 'simple';

/**
 * One rule.
 *
 * The parameter fields are flat and optional rather than a discriminated union
 * on `subject`, because these are stored as JSON and synced, and a shape that
 * reads the same in a database viewer as it does here is worth more than the
 * types it would buy. Each subject below declares which field it reads and
 * ignores the rest, so a rule that changed subject keeps its old parameters
 * harmlessly instead of arriving half-formed.
 */
export interface WeekRule {
  /** Stable key, minted when the rule is created. Identity for edits and lists. */
  readonly id: string;
  readonly subject: RuleSubjectId;
  readonly comparison: RuleComparison;
  /** How many meals. The number in "at least THREE meals under 30 minutes". */
  readonly count: number;
  /** Which meals this rule is about. Empty means every meal in the week. */
  readonly mealTypes: readonly MealType[];

  // --- subject parameters ---
  readonly minutes?: number;
  readonly dishType?: DishTypeId;
  readonly region?: CuisineRegionId;
  readonly ingredientId?: Id;
  readonly tag?: string;
  readonly maxIngredients?: number;
}

/** The rules live on settings, next to the diets and allergens they sit beside. */
export interface WeekRuleSettings {
  readonly weekRules: readonly WeekRule[];
}

export interface RuleSubject {
  readonly id: RuleSubjectId;
  /** Names the subject on its own, for a picker: "Under a time limit". */
  readonly label: string;
  /** Which parameter field this subject reads, and so which control to show. */
  readonly parameter: 'none' | 'minutes' | 'dish-type' | 'region' | 'ingredient' | 'tag' | 'count';
  /**
   * What the parameter starts at when a rule takes this subject.
   *
   * Every subject that can have one does, because the alternative is a rule whose
   * dropdown shows "Pasta & noodles" while the rule itself means "any kind of
   * dish" — a control that is lying about the thing it controls. The exception is
   * `ingredient`, where there is no defensible guess and the rule is honestly
   * unfinished until one is chosen; `isConfigured` is how that is noticed.
   */
  readonly defaults?: Partial<WeekRule>;
  /** The per-recipe half of the rule. */
  readonly filter: (rule: WeekRule) => RecipeFilter;
  /**
   * The subject as it reads inside a sentence — "under 30 minutes", "pasta",
   * "with halloumi" — so `describeRule` can build one line rather than every
   * caller assembling its own.
   */
  readonly phrase: (rule: WeekRule, ingredientName?: string) => string;
}

export const DEFAULT_RULE_MINUTES = 30;
export const DEFAULT_RULE_MAX_INGREDIENTS = 5;

export const RULE_SUBJECTS: readonly RuleSubject[] = [
  {
    id: 'quick',
    label: 'Quick to cook',
    parameter: 'minutes',
    defaults: { minutes: DEFAULT_RULE_MINUTES },
    filter: (r) => ({ maxTotalMinutes: r.minutes ?? DEFAULT_RULE_MINUTES }),
    phrase: (r) => `under ${r.minutes ?? DEFAULT_RULE_MINUTES} minutes`,
  },
  {
    id: 'dish-type',
    label: 'A kind of dish',
    parameter: 'dish-type',
    defaults: { dishType: 'pasta' },
    filter: (r) => (r.dishType ? { dishTypes: [r.dishType] } : {}),
    phrase: (r) =>
      r.dishType ? `that are ${DISH_TYPE_PHRASES[r.dishType]}` : 'of any kind',
  },
  {
    id: 'region',
    label: 'From a region',
    parameter: 'region',
    defaults: { region: 'italy' },
    filter: (r) => (r.region ? { regions: [r.region] } : {}),
    phrase: (r) => (r.region ? `from ${CUISINE_REGION_LABELS[r.region]}` : 'from anywhere'),
  },
  {
    id: 'ingredient',
    label: 'Using an ingredient',
    parameter: 'ingredient',
    filter: (r) => (r.ingredientId ? { includeIngredients: [r.ingredientId] } : {}),
    phrase: (r, name) => `with ${name ?? r.ingredientId ?? 'an ingredient'}`,
  },
  {
    id: 'tag',
    label: 'With a tag',
    parameter: 'tag',
    filter: (r) => (r.tag ? { anyTags: [r.tag] } : {}),
    phrase: (r) => (r.tag ? `tagged ${r.tag}` : 'with any tag'),
  },
  {
    id: 'high-protein',
    label: 'High protein',
    parameter: 'none',
    filter: () => ({ highProteinOnly: true }),
    phrase: () => 'high in protein',
  },
  {
    id: 'in-season',
    label: 'In season',
    parameter: 'none',
    filter: () => ({ seasonalOnly: true }),
    phrase: () => 'in season',
  },
  {
    id: 'simple',
    label: 'Few ingredients',
    parameter: 'count',
    defaults: { maxIngredients: DEFAULT_RULE_MAX_INGREDIENTS },
    filter: (r) => ({ maxIngredientCount: r.maxIngredients ?? DEFAULT_RULE_MAX_INGREDIENTS }),
    phrase: (r) =>
      `with ${r.maxIngredients ?? DEFAULT_RULE_MAX_INGREDIENTS} ingredients or fewer`,
  },
];

export function getSubject(id: RuleSubjectId): RuleSubject {
  return RULE_SUBJECTS.find((s) => s.id === id) ?? RULE_SUBJECTS[0];
}

/**
 * Changes what a rule is about, bringing a starting parameter with it.
 *
 * The reason this is not a one-line spread at the call site: a rule that took the
 * `dish-type` subject with no `dishType` set means "any kind of dish", while the
 * dropdown next to it is already showing one. Nobody would read that sentence
 * twice, and the rule would quietly be satisfied by every meal in the week.
 *
 * `tags` comes from the caller because the tag vocabulary belongs to the library,
 * not to this file — there is no tag it would be right to hardcode here.
 */
export function withSubject(
  rule: WeekRule,
  subject: RuleSubjectId,
  tags: readonly string[] = [],
): WeekRule {
  const next: WeekRule = { ...rule, subject, ...getSubject(subject).defaults };
  if (subject === 'tag' && next.tag === undefined && tags.length > 0) {
    return { ...next, tag: tags[0] };
  }
  return next;
}

/**
 * Whether the rule has the parameter its subject needs.
 *
 * Only `ingredient` can honestly be unset — everything else ships a default — and
 * an unfinished rule matches NOTHING rather than everything. A half-written rule
 * that silently passes is worse than one that visibly fails: the first looks like
 * the planner ignoring you, the second looks like the sentence you have not
 * finished writing.
 */
export function isConfigured(rule: WeekRule): boolean {
  switch (getSubject(rule.subject).parameter) {
    case 'dish-type': return rule.dishType !== undefined;
    case 'region': return rule.region !== undefined;
    case 'ingredient': return rule.ingredientId !== undefined;
    case 'tag': return rule.tag !== undefined;
    default: return true;
  }
}

/** The whole rule as one line: "at least 3 full meals under 30 minutes". */
export function describeRule(rule: WeekRule, ingredientName?: string): string {
  const subject = getSubject(rule.subject);
  const comparison = rule.comparison === 'at-least' ? 'At least' : 'At most';
  return `${comparison} ${rule.count} ${mealNoun(rule)} ${subject.phrase(rule, ingredientName)}`;
}

/** "full meals", "snacks", "meals" — the noun the count is counting. */
export function mealNoun(rule: Pick<WeekRule, 'mealTypes' | 'count'>): string {
  const plural = rule.count === 1 ? '' : 's';
  if (rule.mealTypes.length === 0 || rule.mealTypes.length === 3) return `meal${plural}`;
  return rule.mealTypes
    .map((t) => (t === 'snack' ? `snack${plural}` : `${t} meal${plural}`))
    .join(' or ');
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

/**
 * A rule with its matching recipes already worked out.
 *
 * The set is the point. `scorePlan` runs thousands of times per generation and
 * would otherwise re-test every recipe in every slot against every rule — and
 * the protein and season subjects are not cheap to test. Recipes do not change
 * during a search, so the answer is computed once when the planning context is
 * assembled and reduced to set membership afterwards.
 */
export interface CompiledRule {
  readonly rule: WeekRule;
  readonly matches: ReadonlySet<Id>;
}

export function compileRules(
  rules: readonly WeekRule[],
  recipes: Iterable<Recipe>,
  ctx: FilterContext,
): CompiledRule[] {
  const all = [...recipes];
  return rules.map((rule) => {
    const matches = new Set<Id>();
    if (!isConfigured(rule)) return { rule, matches };

    const filter = getSubject(rule.subject).filter(rule);
    for (const recipe of all) {
      if (testRecipe(recipe, filter, ctx) === null) matches.add(recipe.id);
    }
    return { rule, matches };
  });
}

// ---------------------------------------------------------------------------
// Measuring a week against the rules
// ---------------------------------------------------------------------------

export interface RuleStatus {
  readonly rule: WeekRule;
  /** Meals in the week that match the subject, within the meal types it covers. */
  readonly matched: number;
  /** Meals still needed, or meals over the cap. Zero when the rule is met. */
  readonly shortfall: number;
  readonly satisfied: boolean;
  /** Recipes in the library that match at all — 0 means the rule cannot ever be met. */
  readonly available: number;
}

/** How many of this week's meals a compiled rule matches. */
export function countMatching(slots: readonly PlanSlot[], compiled: CompiledRule): number {
  const { rule, matches } = compiled;
  let n = 0;
  for (const slot of slots) {
    if (slot.recipeId === null) continue;
    if (rule.mealTypes.length > 0 && !rule.mealTypes.includes(slot.mealType)) continue;
    if (matches.has(slot.recipeId)) n++;
  }
  return n;
}

export function shortfallOf(slots: readonly PlanSlot[], compiled: CompiledRule): number {
  const matched = countMatching(slots, compiled);
  return compiled.rule.comparison === 'at-least'
    ? Math.max(0, compiled.rule.count - matched)
    : Math.max(0, matched - compiled.rule.count);
}

export function evaluateRules(
  slots: readonly PlanSlot[],
  compiled: readonly CompiledRule[],
): RuleStatus[] {
  return compiled.map((c) => {
    const matched = countMatching(slots, c);
    const shortfall = shortfallOf(slots, c);
    return {
      rule: c.rule,
      matched,
      shortfall,
      satisfied: shortfall === 0,
      available: c.matches.size,
    };
  });
}

/**
 * Total meals the week is short across every rule. What the scorer charges for.
 *
 * A sum rather than a count of broken rules, so a week two meals short of a rule
 * is worse than a week one meal short of it — otherwise the search has no reason
 * to make partial progress, and partial progress is the only way it gets there.
 */
export function rulePenalty(
  slots: readonly PlanSlot[],
  compiled: readonly CompiledRule[],
): number {
  let total = 0;
  for (const c of compiled) total += shortfallOf(slots, c);
  return total;
}

/**
 * A rule the library cannot satisfy, and why — so Settings can say "you have no
 * recipes from Africa" at the moment the rule is written, rather than leaving it
 * to be discovered as an unexplained empty slot next Monday.
 */
export function impossibleReason(status: RuleStatus): string | null {
  if (!isConfigured(status.rule)) return 'This rule is not finished.';
  if (status.rule.comparison === 'at-most') return null;
  if (status.available === 0) return 'Nothing in your library matches this.';
  if (status.available < status.rule.count) {
    return `Only ${status.available} recipe${status.available === 1 ? '' : 's'} in your library match.`;
  }
  return null;
}

/** A new rule, ready to edit. Full meals only, for the reason at the top of this file. */
export function newRule(subject: RuleSubjectId = 'quick', tags: readonly string[] = []): WeekRule {
  const blank: WeekRule = {
    id: `rule-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    subject: 'quick',
    comparison: 'at-least',
    count: 2,
    mealTypes: ['full'],
  };
  // Through the same door an edit goes through, so a new rule and a switched one
  // cannot end up with different starting parameters.
  return withSubject(blank, subject, tags);
}
