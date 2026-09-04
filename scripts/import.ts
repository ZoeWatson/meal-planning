/**
 * Import CLI — the authoring loop for a large library.
 *
 *   npm run import check <file>              validate, report what is wrong
 *   npm run import stub  <file> [-o out]     emit ingredient skeletons for what is missing
 *   npm run import merge <a> <b> [-o out]    combine bundles into one file
 *   npm run import export [-o out]           dump the built-in library as a bundle
 *
 * The intended cycle is check → stub → fill in the stubs → merge → check again,
 * repeating until `check` is clean. Doing this at the command line rather than in
 * the app matters: a 500-recipe file needs a text editor and a fast loop, not a
 * phone screen.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  importBundle, summarizeUnconvertible, summarizeUnresolved,
  type ImportBundle, type RawIngredient, type RawRecipe,
} from '../src/domain/import/importer';
import { stubsFromResult } from '../src/domain/import/stubs';
import { toBundle } from '../src/domain/import/export';
import { loadSeedData } from '../src/data/seed';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${OFF}\n${'─'.repeat(text.length)}`);
}

function readBundle(path: string): ImportBundle {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`Cannot read ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    // A bare array is accepted and sniffed, because "here is my recipes.json"
    // is the shape people actually have before reading any documentation.
    if (Array.isArray(parsed)) {
      const looksLikeIngredients = parsed.some(
        (x) => typeof x === 'object' && x !== null && 'purchase' in x,
      );
      return looksLikeIngredients ? { ingredients: parsed } : { recipes: parsed };
    }
    return parsed as ImportBundle;
  } catch (err) {
    fail(`${path} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(message: string): never {
  console.error(`${RED}${message}${OFF}`);
  process.exit(1);
}

/** Splits argv into positional files and the `-o` output path. */
function parseArgs(args: string[]): { files: string[]; out: string | null } {
  const files: string[] = [];
  let out: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') {
      out = args[i + 1] ?? null;
      i++;
    } else if (!args[i].startsWith('-')) {
      files.push(args[i]);
    }
  }

  return { files, out };
}

// ---------------------------------------------------------------------------

function commandCheck(path: string, standalone: boolean): void {
  const bundle = readBundle(path);
  const seed = loadSeedData();

  // Files resolve against the built-in dictionary by default, PLUS whatever they
  // define themselves. Resolving only against the file's own ingredients (the
  // first version of this) meant a merged bundle reported garlic and salt as
  // missing purely because they live in the base library — which sends you off
  // creating duplicates of ingredients you already have.
  const result = importBundle(bundle, standalone ? [] : seed.ingredients);

  heading(`Checking ${path}`);
  console.log(`ingredients  ${result.ingredients.length}`);
  console.log(`recipes      ${result.recipes.length} imported, ${result.rejected.length} rejected`);

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');

  const unresolved = summarizeUnresolved(result);
  if (unresolved.length > 0) {
    heading('Missing ingredients, most wanted first');
    console.log(`${DIM}A handful of these usually account for most rejections.${OFF}\n`);
    for (const { item, count } of unresolved.slice(0, 25)) {
      console.log(`  ${String(count).padStart(3)} ×  ${item}`);
    }
    if (unresolved.length > 25) console.log(`  ${DIM}… and ${unresolved.length - 25} more${OFF}`);
    console.log(`\n  ${DIM}Fix with: npm run import stub ${path}${OFF}`);
  }

  const unconvertible = summarizeUnconvertible(result);
  if (unconvertible.length > 0) {
    heading('Known ingredients with an unconvertible unit');
    console.log(`${DIM}These already exist — they need a unit definition, not a new record.${OFF}\n`);
    for (const u of unconvertible.slice(0, 20)) {
      console.log(
        `  ${String(u.count).padStart(3)} ×  ${u.ingredientId}  ${DIM}needs${OFF} ` +
        `countUnits["${u.unit}"] ${DIM}(grams per one) or gramsPerMl${OFF}`,
      );
    }
  }

  const otherErrors = errors.filter((e) => !e.unresolvedItem && !e.unconvertible);
  if (otherErrors.length > 0) {
    heading('Other errors');
    for (const e of otherErrors.slice(0, 20)) {
      console.log(`  ${RED}${e.path}${OFF}\n    ${e.message}`);
    }
    if (otherErrors.length > 20) console.log(`  ${DIM}… and ${otherErrors.length - 20} more${OFF}`);
  }

  if (warnings.length > 0) {
    heading(`Warnings (${warnings.length})`);
    // Warnings cluster hard — one message repeated 200 times is one problem.
    const byMessage = new Map<string, number>();
    for (const w of warnings) {
      const key = w.message.replace(/"[^"]*"/g, '"…"');
      byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
    }
    for (const [message, count] of [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${YELLOW}${String(count).padStart(3)} ×${OFF} ${message}`);
    }
  }

  heading('Result');
  if (result.ok) {
    console.log(`${GREEN}✓ Clean — ready to import.${OFF}`);
  } else {
    console.log(`${RED}✗ ${result.rejected.length} recipes rejected, ${errors.length} errors.${OFF}`);
    process.exitCode = 1;
  }
}

function commandStub(path: string, out: string, standalone: boolean): void {
  const bundle = readBundle(path);
  const seed = loadSeedData();
  const result = importBundle(bundle, standalone ? [] : seed.ingredients);
  const stubs = stubsFromResult(result);

  if (stubs.length === 0) {
    console.log(`${GREEN}Nothing missing — no stubs needed.${OFF}`);
    return;
  }

  writeFileSync(out, JSON.stringify({ ingredients: stubs }, null, 2), 'utf8');

  heading(`Wrote ${stubs.length} ingredient stubs to ${out}`);
  console.log(`${DIM}Guessed categories — check these, then delete the TODO and _usedBy keys.${OFF}\n`);

  const byCategory = new Map<string, number>();
  for (const s of stubs) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
  for (const [category, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${category}`);
  }

  console.log(`\n${BOLD}Check first, in this order:${OFF}`);
  console.log(`  1. ${BOLD}purchase.divisible${OFF} — sold loose by weight, or in a fixed pack?`);
  console.log(`  2. ${BOLD}purchase.gramsPerPack${OFF} — the SMALLEST size you can actually buy.`);
  console.log(`  ${DIM}Those two drive the entire waste model. The rest can be approximate.${OFF}`);
}

function commandMerge(paths: string[], out: string): void {
  const ingredients: RawIngredient[] = [];
  const recipes: RawRecipe[] = [];

  for (const path of paths) {
    const bundle = readBundle(path);
    ingredients.push(...(bundle.ingredients ?? []));
    recipes.push(...(bundle.recipes ?? []));
  }

  // Stub scaffolding is stripped here so a merged file is valid input rather than
  // carrying editor annotations forward into the library.
  const cleaned = ingredients.map((ing) => {
    const rest = { ...ing } as unknown as Record<string, unknown>;
    delete rest.TODO;
    delete rest._usedBy;
    return rest as unknown as RawIngredient;
  });

  const merged: ImportBundle = { ingredients: cleaned, recipes };
  writeFileSync(out, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Merged ${cleaned.length} ingredients and ${recipes.length} recipes → ${out}`);
  console.log(`${DIM}Now run: npm run import check ${out}${OFF}`);
}

function commandExport(out: string): void {
  const seed = loadSeedData();
  writeFileSync(out, JSON.stringify(toBundle(seed.ingredients, seed.recipes), null, 2), 'utf8');
  console.log(
    `Exported ${seed.ingredients.length} ingredients and ${seed.recipes.length} recipes → ${out}`,
  );
}

// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { files, out } = parseArgs(rest);
const standalone = rest.includes('--standalone');

switch (command) {
  case 'check':
    if (!files[0]) fail('Usage: npm run import check <file> [--standalone]');
    commandCheck(files[0], standalone);
    break;
  case 'stub':
    if (!files[0]) fail('Usage: npm run import stub <file> [-o out.json] [--standalone]');
    commandStub(files[0], out ?? 'ingredient-stubs.json', standalone);
    break;
  case 'merge':
    if (files.length < 2) fail('Usage: npm run import merge <a.json> <b.json> [-o out.json]');
    commandMerge(files, out ?? 'merged-bundle.json');
    break;
  case 'export':
    commandExport(out ?? 'library-export.json');
    break;
  default:
    console.log(`${BOLD}Import pipeline${OFF}

  npm run import check <file>             validate and report what is wrong
  npm run import stub  <file> [-o out]    emit ingredient skeletons for what is missing
  npm run import merge <a> <b> [-o out]   combine bundles into one file
  npm run import export [-o out]          dump the built-in library

  --standalone    resolve only against the file's own ingredients, ignoring the
                  built-in library. Use when checking a self-contained bundle.

${DIM}Typical loop: check → stub → fill in the stubs → merge → check again.
See docs/import-format.md for the format.${OFF}`);
    process.exit(command === undefined ? 0 : 1);
}
