import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { AppState } from '../state/useAppState';
import { db } from '../db/database';
import {
  addCustomItem, clearChecks, keepInPantry, lookupBarcode, recordCarryOverFromPlan,
  recordShopTotal, rememberBarcode, removeCustomItem, setChecked, setInStock, setLinePrice,
  setRemoved, updateCustomItem,
} from '../db/repository';
import type { DisplayLine } from '../domain/grocery';
import { worthKeeping } from '../domain/pantry';
import { carryOverOf } from '../domain/waste';
import { scorePlan } from '../domain/planner/scoring';
import {
  centsToInput, formatMoney, parseMoney, todayISO, type CustomItem,
} from '../domain/budget';
import { TREAT_KIND_LABELS, getTreat } from '../domain/treats';
import { CheckIcon, HouseIcon } from '../components/icons';
import { BarcodeScanner, isScanningSupported } from '../components/BarcodeScanner';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { Sheet } from '../components/Sheet';

const AISLE_LABELS: Record<string, string> = {
  produce: 'Produce', bakery: 'Bakery', meat: 'Meat', seafood: 'Seafood',
  dairy: 'Dairy & eggs', frozen: 'Frozen', grain: 'Grains & pasta', legume: 'Legumes',
  canned: 'Tins & jars', condiment: 'Condiments', oil: 'Oils', spice: 'Spices',
  baking: 'Baking', beverage: 'Drinks', other: 'Other',
  // Not an aisle in any shop, which is rather the point — half of these are not
  // sold in a supermarket at all, so they get their own heading at the bottom.
  treat: 'Treats',
};

/** A planned line and an ad-hoc one, flattened so the list renders uniformly. */
interface Row {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly qtyText: string;
  readonly meta: string;
  readonly badges: readonly { text: string; tone?: 'warn' | 'accent' }[];
  readonly checked: boolean;
  /** Taken off this week's list. Off the shop and out of the counts, not deleted. */
  readonly removed: boolean;
  /** Off the list because the cupboard already has it. Always implies `removed`. */
  readonly inStock: boolean;
  readonly amountCents?: number;
  readonly custom?: CustomItem;
  readonly ingredientId?: string;
  readonly usedBy: readonly string[];
}

export function GroceryScreen({
  state, onPlan,
}: {
  state: AppState;
  onPlan: () => void;
}): JSX.Element {
  const {
    plan, groceryLines, removedLines, groceryList, ingredients, pantry, ctx, settings,
  } = state;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [pricing, setPricing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // No default argument: `useLiveQuery`'s third parameter infers `never[]` from an
  // empty literal and poisons the element type. `?? []` after the fact keeps the
  // real one.
  const customItems = useLiveQuery(
    () => (plan
      ? db.customItems.where('planId').equals(plan.id).toArray()
      : Promise.resolve<CustomItem[]>([])),
    [plan?.id],
  ) ?? [];

  const checks = useLiveQuery(() => db.checks.toArray(), []) ?? [];

  /**
   * Lines said to be in the cupboard already, for this plan.
   *
   * Scoped to the plan for the same reason the ticks are: a check row outlives
   * the week it was written for, and "we have rice" was said about one shop.
   */
  const inStockIds = useMemo(
    () => new Set(checks.filter((c) => c.inStock === true && c.planId === plan?.id)
      .map((c) => c.ingredientId)),
    [checks, plan?.id],
  );

  /** What is already on the pantry roster, so the offer is not made twice. */
  const inPantry = useMemo(
    () => new Set(pantry.map((p) => p.ingredientId)),
    [pantry],
  );
  const priceByIngredient = useMemo(
    () => new Map(checks.filter((c) => c.amountCents !== undefined)
      .map((c) => [c.ingredientId, c.amountCents!])),
    [checks],
  );

  /**
   * This plan's ticks, by item id.
   *
   * Planned lines arrive with their check already merged in, but treats do not —
   * they are not grocery lines and never pass through the list builder — so
   * their ticks are read straight from the table here.
   */
  const treatChecks = useMemo(
    () => new Map(checks.filter((c) => c.planId === plan?.id).map((c) => [c.ingredientId, c])),
    [checks, plan?.id],
  );

  const rows = useMemo<Row[]>(() => {
    const plannedRow = (line: DisplayLine, removed: boolean): Row => ({
      key: `p:${line.ingredientId}`,
      name: line.name,
      category: line.category,
      qtyText: line.buyText,
      meta: [
        line.needText ? `needs ${line.needText}` : null,
        line.usedBy.length > 0
          ? `${line.usedBy.length} meal${line.usedBy.length === 1 ? '' : 's'}`
          : null,
      ].filter(Boolean).join(' · '),
      badges: [
        ...(line.fromStaples ? [{ text: 'staple' }] : []),
        ...(line.fromPantry ? [{ text: 'pantry' }] : []),
        ...(line.fromWildcard ? [{ text: 'grab bag', tone: 'accent' as const }] : []),
        ...(line.wasteCost > 0.35 ? [{ text: 'may spoil', tone: 'warn' as const }] : []),
      ],
      checked: line.checked,
      removed,
      inStock: inStockIds.has(line.ingredientId),
      amountCents: priceByIngredient.get(line.ingredientId),
      ingredientId: line.ingredientId,
      usedBy: line.usedBy,
    });

    // Both halves of the same list, built the same way, because what was taken
    // off has to be nameable to be offered back.
    const planned: Row[] = [
      ...groceryLines.map((line) => plannedRow(line, false)),
      ...removedLines.map((line) => plannedRow(line, true)),
    ];

    // The week's treat bag. Not grocery lines — they have no grams, no packs and
    // no waste — but they are things to pick up on the same trip, so they belong
    // on the same list rather than in a second one nobody opens in a shop.
    const treats: Row[] = (plan?.treats ?? []).flatMap((item) => {
      const treat = getTreat(item.treatId);
      if (!treat) return [];
      const check = treatChecks.get(treat.id);
      return [{
        key: `t:${treat.id}`,
        name: treat.name,
        category: 'treat',
        qtyText: '',
        meta: treat.note,
        badges: [{ text: TREAT_KIND_LABELS[treat.kind], tone: 'accent' as const }],
        checked: check?.checked ?? false,
        // Off this list, not out of the week: the treat bag is the week screen's,
        // and the ✕ down there is the one that means "not this week at all".
        removed: check?.removed === true,
        inStock: check?.inStock === true,
        // The catalogue price is an estimate and stays out of the running total
        // until a real one is entered at the shelf, like every other line.
        amountCents: check?.amountCents,
        ingredientId: treat.id,
        usedBy: [],
      }];
    });

    const extra: Row[] = customItems.map((item) => ({
      key: `c:${item.id}`,
      name: item.label,
      category: item.category,
      qtyText: item.quantityText ?? '',
      meta: 'added by you',
      badges: [{ text: 'added', tone: 'accent' as const }],
      checked: item.checked,
      removed: item.removed === true,
      inStock: item.inStock === true,
      amountCents: item.amountCents,
      custom: item,
      usedBy: [],
    }));

    return [...planned, ...treats, ...extra];
  }, [groceryLines, removedLines, customItems, priceByIngredient, plan?.treats, treatChecks,
      inStockIds]);

  /**
   * The shop, and what has been taken out of it.
   *
   * Every count is over the first list. A line you are not buying is not one of
   * the things left to find, and a price entered against it before it came off is
   * not money this trip is going to cost.
   */
  const shopping = rows.filter((r) => !r.removed);
  const takenOff = rows.filter((r) => r.removed);

  const done = shopping.filter((r) => r.checked).length;
  const total = shopping.length;
  const enteredCents = shopping.reduce((sum, r) => sum + (r.amountCents ?? 0), 0);
  const pricedCount = shopping.filter((r) => r.amountCents !== undefined).length;

  const estimatedCents = useMemo(() => {
    if (!plan || !ctx) return 0;
    const meals = Math.round(scorePlan(plan.slots, plan.wildcards, ctx).spend * 100);
    // Treats are priced by the catalogue rather than by the waste model, so they
    // are added on here. Leaving them out would make every shop that included
    // them look over the estimate by the price of a bar of chocolate.
    const treats = (plan.treats ?? []).reduce(
      (sum, t) => sum + (getTreat(t.treatId)?.priceCents ?? 0),
      0,
    );
    return meals + treats;
  }, [plan, ctx]);

  // `rows` rather than `total`: a list every line of which has been taken off is
  // not an empty list, and "nothing to buy yet" would hide the way back to it.
  if (!plan || rows.length === 0) {
    return (
      <main className="screen">
        <div className="header"><h1>Shopping list</h1></div>
        <div className="empty" style={{ marginTop: '18vh' }}>
          <h2>Nothing to buy yet</h2>
          <p>Plan a week and the list builds itself.</p>
          <button className="btn primary" onClick={onPlan}>Go to the week</button>
        </div>
      </main>
    );
  }

  const planId = plan.id;
  const visible = hideDone ? shopping.filter((r) => !r.checked) : shopping;
  const groups = groupByAisle(visible);

  async function toggle(row: Row): Promise<void> {
    if (row.custom) await updateCustomItem(row.custom.id, { checked: !row.checked });
    else if (row.ingredientId) await setChecked(planId, row.ingredientId, !row.checked);
  }

  /**
   * Takes a line off this week's list, or puts it back.
   *
   * Three kinds of line and two mechanisms, because an item added by hand is a
   * record of its own while a planned line is derived and has nowhere to keep
   * anything. Both are hidden rather than deleted, so the way back off the bottom
   * of the screen is the same for all three.
   */
  async function setRowRemoved(row: Row, removed: boolean): Promise<void> {
    if (row.custom) await updateCustomItem(row.custom.id, { removed, inStock: undefined });
    else if (row.ingredientId) await setRemoved(planId, row.ingredientId, removed);
  }

  /**
   * Takes a line off because the cupboard has it — the same removal, with the
   * reason kept.
   *
   * Worth keeping because the two are not the same afterwards. "Not this week"
   * is a decision that expires on its own; "we have this" is a fact about a
   * cupboard, and a fact about a cupboard is the one kind that might be worth
   * writing down.
   */
  async function setRowInStock(row: Row, inStock: boolean): Promise<void> {
    if (row.custom) {
      await updateCustomItem(row.custom.id, {
        removed: inStock, inStock: inStock ? true : undefined,
      });
    } else if (row.ingredientId) {
      await setInStock(planId, row.ingredientId, inStock);
    }
  }

  /**
   * Whether to offer this a permanent home in the pantry.
   *
   * Only for things that keep, and only for what is not on the roster already.
   * `worthKeeping` says why offering it for parsley would be a bug rather than a
   * convenience: a stocked pantry item is free to the planner, so a herb in there
   * silently discounts every week after this one.
   */
  function canKeep(row: Row): boolean {
    if (!row.inStock || row.custom || !row.ingredientId) return false;
    if (inPantry.has(row.ingredientId)) return false;
    const ing = ingredients.get(row.ingredientId);
    return ing !== undefined && worthKeeping(ing);
  }

  return (
    <main className="screen">
      <div className="header">
        <div className="row between">
          <h1>Shopping list</h1>
          <span className="small dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {done} / {total}
          </span>
        </div>
        <div className="progress">
          <div style={{ width: total === 0 ? '0%' : `${(done / total) * 100}%` }} />
        </div>
        {/* The running total is the point of entering prices at the shelf: you
            find out you are over before the till, not after. */}
        {pricedCount > 0 && (
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="tiny faint">{pricedCount} of {total} priced</span>
            <span className="small strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(enteredCents, settings.currency)}
            </span>
          </div>
        )}
      </div>

      <div className="chips" style={{ marginTop: 10 }}>
        <button className="chip" aria-pressed={hideDone} onClick={() => setHideDone((v) => !v)}>
          {hideDone ? 'Showing what is left' : 'Hide what is in the basket'}
        </button>
        <button className="chip" onClick={() => setAdding(true)}>+ Add item</button>
        <button className="chip" onClick={() => void clearChecks(planId)}>Untick all</button>
      </div>

      {groups.map(([category, items]) => (
        <CollapsibleSection
          key={category}
          id={`grocery:${category}`}
          title={AISLE_LABELS[category] ?? category}
          closedNote={`${items.filter((r) => r.checked).length}/${items.length}`}
        >
          {items.map((row) => (
            <div className={`gline${row.checked ? ' done' : ''}`} key={row.key}>
              <button
                className="tickbox"
                aria-label={row.checked ? `Untick ${row.name}` : `Tick ${row.name}`}
                aria-pressed={row.checked}
                onClick={() => void toggle(row)}
              >
                <CheckIcon />
              </button>

              <button
                className="grow"
                style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }}
                onClick={() => setExpanded(expanded === row.key ? null : row.key)}
              >
                <span className="gname">{row.name}</span>
                <span className="gmeta">
                  {row.badges.map((b) => (
                    <span className={`badge${b.tone ? ` ${b.tone}` : ''}`} key={b.text}>{b.text}</span>
                  ))}
                  {expanded === row.key && row.usedBy.length > 0 ? row.usedBy.join(', ') : row.meta}
                </span>
              </button>

              <span className="gqty" style={{ marginRight: 6 }}>{row.qtyText}</span>

              <button
                className={`price-chip${row.amountCents !== undefined ? ' set' : ''}`}
                aria-label={`Price for ${row.name}`}
                onClick={() => setPricing(row)}
              >
                {row.amountCents !== undefined
                  ? formatMoney(row.amountCents, settings.currency)
                  : '＋$'}
              </button>

              {/* On the line itself rather than behind opening it: this is
                  pressed while standing at the shelf looking at the thing, not
                  after reading about it, so making it wait for a second tap
                  would cost more than it saves. */}
              <button
                className="btn small ghost"
                aria-label={`Already have ${row.name} — take it off the list`}
                onClick={() => void setRowInStock(row, true)}
              >
                <HouseIcon size={15} />
              </button>

              {/* The same ✕ the week screen puts on a meal, meaning the same
                  thing one step further along: not this week. Here it is the
                  trolley it comes out of rather than the week — the meal that
                  wanted it is untouched, which is why it can say "already have
                  this" without lying to the planner about next week. */}
              <button
                className="btn small ghost"
                // Not "Remove", which beside an ingredient could mean out of the
                // meal, or out of the library. It means neither.
                aria-label={`Take ${row.name} off the list`}
                onClick={() => void setRowRemoved(row, true)}
              >
                ✕
              </button>
            </div>
          ))}
        </CollapsibleSection>
      ))}

      {/* The way back, and the only one. Kept on the same screen rather than
          offered for ten seconds after the press, because the mistake this
          insures against is not always noticed in the ten seconds after it: a ✕
          on a phone in a shop is a thumb's width from the price beside it, and
          the line simply leaves the aisle it was in. A list is also a thing
          people put down and pick up again. */}
      {takenOff.length > 0 && (
        <CollapsibleSection
          id="grocery:taken-off"
          title="Taken off the list"
          closedNote={`${takenOff.length}`}
        >
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Not being bought, and not in the total. The meals that wanted them are
            unchanged, so next week's list starts with them back on it — including
            the ones you already have, unless you keep them in the pantry.
          </p>
          {takenOff.map((row) => (
            <div className="gline off" key={row.key}>
              <span className="grow">
                <span className="gname">{row.name}</span>
                <span className="gmeta">
                  {/* Which of the two things this line is doing down here. Both
                      are "not being bought"; only one of them is a fact that
                      could still be true next week. */}
                  {row.inStock && <span className="badge">already have</span>}
                  {[row.qtyText, AISLE_LABELS[row.category] ?? row.category]
                    .filter(Boolean).join(' · ')}
                </span>
              </span>

              <button
                className="btn small"
                aria-label={row.inStock
                  ? `Put ${row.name} back on the list — you need it after all`
                  : `Put ${row.name} back on the list`}
                onClick={() => void setRowRemoved(row, false)}
              >
                Put back
              </button>

              {/*
                The offer, and only an offer. Marking a line in stock is about
                this shop; a pantry row is a standing claim about a cupboard, and
                promoting one silently would be the app deciding that half a bag
                of rice is a policy. It shows up only for things that keep, so it
                never suggests filing a bunch of parsley.

                On its own row under the name rather than beside Put back. Two
                buttons and a struck-through name do not fit across a phone, and
                the one that needs the room is this one: "Put back" is obvious and
                this is not, so it is the one that gets to say what it does.
              */}
              {canKeep(row) && (
                <div className="gline-more">
                  <button
                    className="btn small ghost icon-btn"
                    aria-label={`Add ${row.name} to the pantry, so it stops being added here`}
                    onClick={() => void keepInPantry(planId, row.ingredientId!)}
                  >
                    <HouseIcon size={15} />
                    Add to pantry
                  </button>
                  <span className="tiny faint">
                    Stops it being added at all, until you say it has run out.
                  </span>
                </div>
              )}
            </div>
          ))}
        </CollapsibleSection>
      )}

      <button
        className="btn primary block"
        style={{ marginTop: 24 }}
        onClick={() => setFinishing(true)}
      >
        Finish shop
      </button>
      <p className="tiny faint" style={{ marginTop: 6, textAlign: 'center' }}>
        Records what it cost and banks any shelf-stable leftovers for next week.
      </p>

      {pricing && (
        <PriceSheet
          row={pricing}
          planId={planId}
          currency={settings.currency}
          onClose={() => setPricing(null)}
        />
      )}
      {adding && (
        <AddItemSheet
          planId={planId}
          currency={settings.currency}
          onClose={() => setAdding(false)}
        />
      )}
      {finishing && (
        <FinishShopSheet
          planId={planId}
          currency={settings.currency}
          enteredCents={enteredCents}
          estimatedCents={estimatedCents}
          pricedCount={pricedCount}
          totalCount={total}
          onClose={() => setFinishing(false)}
          onDone={async () => {
            if (!groceryList) return;
            const entries = groceryList.lines.flatMap((line) => {
              const ing = ingredients.get(line.ingredientId);
              if (!ing || carryOverOf(ing) !== 'pantry') return [];
              const leftover = line.purchaseGrams - line.neededGrams;
              return leftover > 0 ? [{ ingredientId: line.ingredientId, grams: leftover }] : [];
            });
            await recordCarryOverFromPlan(entries);
            await clearChecks(planId);
            for (const item of customItems) await removeCustomItem(item.id);
          }}
        />
      )}
    </main>
  );
}

function groupByAisle(rows: readonly Row[]): Array<[string, Row[]]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = groups.get(row.category);
    if (existing) existing.push(row);
    else groups.set(row.category, [row]);
  }
  return [...groups.entries()];
}

// ---------------------------------------------------------------------------

function PriceSheet({
  row, planId, currency, onClose,
}: {
  row: Row; planId: string; currency: string; onClose: () => void;
}): JSX.Element {
  const [value, setValue] = useState(
    row.amountCents !== undefined ? centsToInput(row.amountCents) : '',
  );
  const cents = parseMoney(value);

  async function save(): Promise<void> {
    if (row.custom) await updateCustomItem(row.custom.id, { amountCents: cents ?? undefined });
    else if (row.ingredientId) await setLinePrice(planId, row.ingredientId, cents);

    // A scanned item remembers its price, so next month it fills itself in.
    if (row.custom?.barcode && cents !== null) {
      await rememberBarcode({
        barcode: row.custom.barcode, label: row.custom.label, lastAmountCents: cents,
      });
    }
    onClose();
  }

  return (
    <Sheet title={row.name} onClose={onClose}>
      <div className="field">
        <label htmlFor="price">What did it cost?</label>
        <input
          id="price" type="text" inputMode="decimal" autoFocus
          value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="0.00"
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        />
        <div className="hint">Buying {row.qtyText || 'this'}.</div>
      </div>

      <button className="btn primary block" onClick={() => void save()}>
        {cents !== null ? `Save ${formatMoney(cents, currency)}` : 'Save'}
      </button>
      {row.amountCents !== undefined && (
        <button
          className="btn block ghost"
          style={{ marginTop: 8 }}
          onClick={() => { setValue(''); void save(); }}
        >
          Clear price
        </button>
      )}
    </Sheet>
  );
}

function AddItemSheet({
  planId, currency, onClose,
}: {
  planId: string; currency: string; onClose: () => void;
}): JSX.Element {
  const [scanning, setScanning] = useState(false);
  const [label, setLabel] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [barcode, setBarcode] = useState<string | null>(null);
  const [recognised, setRecognised] = useState(false);

  const cents = parseMoney(price);

  async function onDetected(code: string): Promise<void> {
    setScanning(false);
    setBarcode(code);

    // Known barcodes fill themselves in; the first scan of anything still needs
    // a name, because a barcode carries no product information on its own.
    const known = await lookupBarcode(code);
    if (known) {
      setLabel(known.label);
      setRecognised(true);
      if (known.lastAmountCents !== undefined) setPrice(centsToInput(known.lastAmountCents));
    }
  }

  async function save(): Promise<void> {
    const name = label.trim();
    if (name === '') return;

    await addCustomItem({
      planId, label: name, category: 'other', checked: false,
      quantityText: quantity.trim() || undefined,
      amountCents: cents ?? undefined,
      barcode: barcode ?? undefined,
    });

    if (barcode) {
      await rememberBarcode({
        barcode, label: name, lastAmountCents: cents ?? undefined,
      });
    }
    onClose();
  }

  return (
    <Sheet title="Add an item" onClose={onClose}>
      {scanning ? (
        <BarcodeScanner
          onDetected={(code) => void onDetected(code)}
          onCancel={() => setScanning(false)}
        />
      ) : (
        <>
          {isScanningSupported() && (
            <button className="btn block" style={{ marginBottom: 12 }} onClick={() => setScanning(true)}>
              Scan a barcode
            </button>
          )}

          {barcode && (
            <div className="card tight small dim">
              {recognised
                ? <>Recognised <strong>{label}</strong> from a previous scan.</>
                : <>New barcode <code>{barcode}</code> — name it once and it will be
                   recognised next time.</>}
            </div>
          )}

          <div className="field">
            <label htmlFor="item-name">Item</label>
            <input
              id="item-name" type="text" value={label} autoFocus={!barcode}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Dish soap"
            />
          </div>

          <div className="field">
            <label htmlFor="item-qty">How much (optional)</label>
            <input
              id="item-qty" type="text" value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="2 packs"
            />
          </div>

          <div className="field">
            <label htmlFor="item-price">Price (optional)</label>
            <input
              id="item-price" type="text" inputMode="decimal" value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <button
            className="btn primary block"
            disabled={label.trim() === ''}
            onClick={() => void save()}
          >
            {cents !== null ? `Add — ${formatMoney(cents, currency)}` : 'Add to list'}
          </button>
        </>
      )}
    </Sheet>
  );
}

function FinishShopSheet({
  planId, currency, enteredCents, estimatedCents, pricedCount, totalCount, onClose, onDone,
}: {
  planId: string;
  currency: string;
  enteredCents: number;
  estimatedCents: number;
  pricedCount: number;
  totalCount: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}): JSX.Element {
  // Prefilled from prices entered at the shelf, but always editable — the till is
  // the authority, and it knows about discounts and deposits that the shelf did not.
  const [total, setTotal] = useState(enteredCents > 0 ? centsToInput(enteredCents) : '');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(() => todayISO());
  const [busy, setBusy] = useState(false);

  const cents = parseMoney(total);
  const valid = cents !== null && cents > 0;

  async function finish(): Promise<void> {
    if (!valid) return;
    setBusy(true);
    try {
      await recordShopTotal(planId, cents, label.trim() || 'Groceries', date);
      await onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Finish shop" onClose={onClose}>
      <div className="field">
        <label htmlFor="total">Total at the till</label>
        <input
          id="total" type="text" inputMode="decimal" autoFocus
          value={total} onChange={(e) => setTotal(e.target.value)}
          placeholder="0.00"
        />
        <div className="hint">
          {pricedCount > 0
            ? `From ${pricedCount} of ${totalCount} items priced. Change it to the receipt total.`
            : 'Enter what the receipt says.'}
        </div>
      </div>

      {/* The only feedback available on how wrong the per-kilo estimates are. */}
      {valid && estimatedCents > 0 && (
        <div className="card tight small dim">
          Planned estimate was {formatMoney(estimatedCents, currency)}
          {cents > estimatedCents
            ? ` — ${formatMoney(cents - estimatedCents, currency)} over.`
            : ` — ${formatMoney(estimatedCents - cents, currency)} under.`}
          <div className="tiny faint" style={{ marginTop: 4 }}>
            Estimates come from rough per-kilo prices, so a steady gap means those
            need adjusting rather than that you overspent.
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="shop">Where</label>
        <input
          id="shop" type="text" value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Shop name"
        />
      </div>

      <div className="field">
        <label htmlFor="shop-date">When</label>
        <input id="shop-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <button className="btn primary block" disabled={!valid || busy} onClick={() => void finish()}>
        {busy ? 'Saving…' : valid ? `Record ${formatMoney(cents, currency)}` : 'Record shop'}
      </button>
      <p className="tiny faint" style={{ marginTop: 6, textAlign: 'center' }}>
        Clears the ticks, banks shelf-stable leftovers, and adds this to the month.
      </p>
    </Sheet>
  );
}
