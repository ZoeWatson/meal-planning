import { Sheet } from '../components/Sheet';

/**
 * Works cited.
 *
 * A page about where the app's numbers come from has to be scrupulously honest
 * about its own provenance, or it is worse than having no page at all — it would
 * lend borrowed authority to figures that never had any.
 *
 * So the governing rule here is the distinction between three different things,
 * which a normal "sources" page tends to blur:
 *
 *   DESIGN     — decisions with stated reasoning. These need an argument, not a
 *                citation, and the argument is given.
 *   ESTIMATES  — numbers written from general knowledge by the model that built
 *                this. They are plausible and unverified, and are labelled as
 *                such every single time.
 *   REFERENCES — where the real authority lives, so a figure that matters can be
 *                checked against it.
 *
 * Nothing here claims a source was consulted. It was not. What is named is where
 * to look.
 */
export function WorksCitedSheet({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Sheet title="Works cited" onClose={onClose}>
      <div
        className="card"
        style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', marginTop: 0 }}
      >
        <strong style={{ color: 'var(--warn)' }}>Read this bit first</strong>
        <div className="small dim" style={{ marginTop: 6 }}>
          Almost every number in this app — prices, nutrition, shelf life, harvest
          months — was written from general knowledge by the AI that built it. None
          of it was copied from a source or checked against one. The figures are
          reasonable starting points, not authorities.
          <br /><br />
          Where a number actually matters to you, the real source is named below so
          you can go and check. The reasoning behind each system is a separate
          thing, and that is explained on its own terms.
        </div>
      </div>

      <Entry
        title="How a week gets planned"
        kind="design"
        what="Picks meals whose ingredients overlap, so you buy fewer things and use more of each."
      >
        <p>
          The goal is <strong>not</strong> to maximise shared ingredients, which
          sounds right and is wrong. Two recipes both using one onion share an
          ingredient and save nothing — you were buying one onion either way.
          Meanwhile one recipe using 15 g of a 60 g bunch of dill wastes three
          quarters of a purchase that nothing else touches.
        </p>
        <p>
          So the thing being minimised is <strong>money you throw away</strong>,
          worked out the way a till does it: round each ingredient up to whole
          packs, subtract what the recipes actually need, and price the remainder
          by how likely it is to spoil. Overlap then emerges as the method rather
          than the target.
        </p>
        <p>
          Choosing 15 recipes from a library of 500 has more combinations than can
          be searched exhaustively, so it builds a week greedily, then tries
          swapping each meal for every alternative until nothing improves, several
          times from different starting points.
        </p>
        <Caveat>
          The search was benchmarked against 400 random weeks and matched the best
          of them — but with only 15 recipes there are just 600 possible weeks, so
          that shows it is not broken rather than that it scales. With a large
          library it is genuinely approximating.
        </Caveat>
      </Entry>

      <Entry
        title="What things cost"
        kind="estimate"
        what="Used to price waste, estimate a shop, and compare against your real till total."
      >
        <p>
          Every per-kilo price in the built-in library is an estimate of British
          Columbia supermarket pricing, written from general knowledge. Nothing was
          surveyed and no store was checked.
        </p>
        <p>
          They are good enough to rank one plan against another, because being
          wrong in the same direction for everything mostly cancels out. They are
          not good enough to budget with.
        </p>
        <Caveat>
          When you record a real till total, the app compares it against its own
          estimate. A steady gap in one direction means these numbers need
          adjusting — that comparison is the only feedback loop there is.
        </Caveat>
      </Entry>

      <Entry
        title="The grab bags"
        kind="design"
        what="Produce, bread, pasta and cheese, drawn at random each week."
      >
        <p>
          Each bag is a small random draw from one shelf of the ingredient
          library, added to the week because it is worth having in rather than
          because a recipe asked for it. The planner minimises waste, and a
          waste-minimising planner left alone will cook the same eight things
          forever — these are the deliberate noise that stops it.
        </p>
        <p>
          The draw is weighted, not uniform: something at its seasonal peak is
          four times as likely to come up as something out of season, and
          anything you have marked as on sale doubles again. Out-of-season
          produce is left in the pool at a quarter weight rather than removed,
          because a January mango is a legitimate thing to want. On the dry
          shelves the weighting does almost nothing — a box of rigatoni has no
          season — which is the right amount of nothing.
        </p>
        <p>
          Which shelf something sits on is worked out from its name rather than
          stored. Bread is the whole bakery aisle. Pasta and cheese are the parts
          of the grain and dairy aisles that match a list of words, so a box of
          orecchiette is pasta and a bag of pearl barley next to it is not.
          Couscous is counted as pasta: it is rolled semolina, it is sold in that
          aisle, and a bag meant to suggest something other than spaghetti is
          worse for leaving it out.
        </p>
        <Caveat>
          Anything your allergies or diets rule out is never drawn, rather than
          drawn and flagged. The check is the same one the planner uses, which
          means it is only as good as the allergen and diet data on the
          ingredient — see the allergens entry for where that is inferred rather
          than known.
        </Caveat>
        <Caveat>
          The bakery, pasta and cheese entries in the library were written for
          these bags, and their prices, shelf lives and nutrition are estimates
          like every other number here. The shelf lives in particular are for an
          unopened pack kept properly, which is not the same as how long the loaf
          on your counter will last.
        </Caveat>
      </Entry>

      <Entry
        title="The treat bag"
        kind="mixed"
        what="Herbal teas and other small things, drawn fresh each week."
      >
        <p>
          The catalogue is a fixed list written for this app: teas, a few things
          to eat, and a good many things that are not food at all. Nothing in it
          costs more than ten dollars, and that ceiling is the feature — a treat
          you have to think about has become a purchase.
        </p>
        <p>
          The draw takes a tea, then something to eat, then something that is not
          food, and goes round again. Picking at random from the whole list would
          be simpler and worse: most of the catalogue is edible, so the bag would
          come back as three snacks often enough to stop being a treat bag. The
          rotation is what keeps a bath, a bunch of flowers or an hour with a
          crossword in the week.
        </p>
        <p>
          The teas are all caffeine-free tisanes. Green, black and white tea are
          the same plant as each other and carry caffeine, so they are not in the
          list — a herbal tea in the evening is a different proposition from a
          cup of something that keeps you awake.
        </p>
        <Caveat>
          Prices are estimates of British Columbia shelf prices, written from
          general knowledge like every other price here. They are there to set an
          expectation — “about six dollars” — not to tell you what you will pay.
        </Caveat>
        <Caveat>
          Herbal teas are not inert, and a few of them interact with common
          medications. The bag knows nothing about that. It checks the allergen
          groups you have set and the diets you have chosen, and nothing else —
          if you take anything regularly, that is worth a look of your own.
        </Caveat>
      </Entry>

      <Entry
        title="The pantry"
        kind="design"
        what="Two dials — how much is left, and how much that matters."
      >
        <p>
          Stock is how much is left: in, low, or out. Necessity is how much that
          matters: must-have, nice to have, alright without. Being out of salt
          and being out of capers are the same stock and nothing like the same
          problem, and a pantry that only knows the first number has to either
          nag about both or stay quiet about both.
        </p>
        <p>
          So the two together decide the list. A must-have goes on it as soon as
          it runs low, because the point of calling something a must-have is not
          running out of it. A nice-to-have waits until it is actually gone.
          Something you are alright without is never added on its own — it is
          there so the planner knows you have it, not so it can be bought.
        </p>
        <p>
          New items start at <em>alright without</em>. A pantry fills up with
          things you added once and forgot, and a default that puts every one of
          them on a shopping list teaches you to stop reading the list.
        </p>
        <p>
          Anything can be put on the list by hand whatever the rule says, and
          taken off again. That choice lasts until the thing is back in stock,
          which is the shop it was about. The obvious alternative — forget the
          override whenever anything changes — is wrong in the common case: you
          add soy sauce, then look properly and find the bottle emptier than you
          thought, and marking it out would cancel the request exactly when it
          became more urgent.
        </p>
        <p>
          Stock is set by hand and never inferred from cooking. Depleting it
          automatically was considered and rejected: nobody measures their olive
          oil, so the model drifts from the cupboard within weeks and then lies
          quietly on every grocery list afterwards. A wrong pantry is worse than
          no pantry, because you stop checking it.
        </p>
        <Caveat>
          Restocking buys one pack, at the pack size the library has for that
          ingredient. It has no idea how much of the thing you actually go
          through, and does not try to guess.
        </Caveat>
      </Entry>

      <Entry
        title="Nutrition"
        kind="estimate"
        what="Per-serving calories and macros, and the “high protein” filter."
      >
        <p>
          Each ingredient carries approximate calories, protein, carbohydrate, fat
          and fibre per 100 g. Recipe figures are simply those summed and divided
          by servings.
        </p>
        <p>
          “High protein” is <em>computed</em> rather than tagged: at least 20 g per
          serving and at least a quarter of calories from protein. Both conditions
          are needed — the gram threshold alone passes an enormous plate of pasta,
          and the ratio alone passes a lettuce leaf. Tagging would mean a recipe
          nobody labelled is indistinguishable from one labelled false.
        </p>
        <Caveat>
          These are raw-ingredient figures. They ignore moisture lost in cooking,
          fat rendered off and poured away, and oil left in the pan. Fine for
          ranking; not a nutrition label. The app also tells you its coverage —
          if some ingredients have no data, the number is a partial sum and says so.
        </Caveat>
        <Refs items={[
          'USDA FoodData Central — the standard food composition database',
          'Canadian Nutrient File (Health Canada) — the Canadian equivalent',
        ]} />
      </Entry>

      <Entry
        title="How long food keeps"
        kind="mixed"
        what="Use-by dates on leftovers, and how much a surplus ingredient counts as waste."
      >
        <p>
          <strong>Cooked leftovers.</strong> Three days in the fridge by default,
          about a day if the dish contains rice, two if it contains seafood, and
          roughly three months frozen. The shortest applicable rule wins, so a
          chicken-and-rice dish takes rice's single day rather than chicken's three.
        </p>
        <p>
          The general shape of this — 3 to 4 days for most cooked dishes, and rice
          as the notable exception because <em>Bacillus cereus</em> survives cooking
          and multiplies as rice cools — is standard public food-safety guidance.
          The specific numbers here were written from knowledge of that guidance,
          not read off it. Where a published range exists, the app takes the bottom
          of it.
        </p>
        <p>
          <strong>Raw ingredients</strong> use a different idea. Surplus only counts
          as waste if it will actually be thrown away, so it is discounted by
          whether it can be kept (cupboard, freezer, or neither), and by how much of
          it a household gets through anyway without a recipe calling for it. That
          second figure is why leftover yogurt barely counts and leftover parsley
          counts almost fully.
        </p>
        <Caveat>
          Dates are a prompt, not a verdict. Nothing here knows how fast a dish
          cooled, how cold your fridge runs, or how many times something has been
          reheated. Trust your senses over the label.
        </Caveat>
        <Refs items={[
          'FoodKeeper (USDA / FDA) — storage times for cooked and raw foods',
          'UK Food Standards Agency — guidance on cooked rice and reheating',
          'Health Canada — safe food storage and leftovers',
        ]} />
      </Entry>

      <Entry
        title="When things are in season"
        kind="estimate"
        what="Nudges plans toward produce that is cheaper and better right now."
      >
        <p>
          Seasonality belongs to a place, not to an ingredient — a tomato is a
          summer crop in Vancouver and a year-round one elsewhere. Each region has
          its own table, splitting <strong>peak</strong> (actively harvested) from{' '}
          <strong>available</strong> (still sold from storage). February apples in
          BC are genuinely local and cheap, but they are not August apples, and the
          two are scored differently.
        </p>
        <p>
          <strong>British Columbia and Ontario</strong> describe local growing
          seasons, written from general knowledge of typical harvest windows.
        </p>
        <p>
          <strong>Las Vegas is built on a different basis, deliberately.</strong>{' '}
          Southern Nevada has almost no commercial agriculture, so a table of what
          grows locally would be accurate, tiny and useless. Instead it describes
          the Southwest supply chain a Vegas shop actually draws on — Yuma, four
          hours away, grows most of America's winter lettuce and brassicas. That
          inverts the Canadian pattern: winter is the good season for greens, and
          high summer is a gap rather than a peak, because desert crops stop
          setting fruit in the worst heat.
        </p>
        <Caveat>
          Microclimates vary and any given year shifts by two or three weeks. An
          ingredient with no entry is treated as unknown rather than out of season,
          so gaps in the data never quietly penalise a plan.
        </Caveat>
        <Refs items={[
          'BC Ministry of Agriculture and Food — harvest availability calendars',
          'Foodland Ontario — availability guide',
          'USDA Agricultural Marketing Service — shipping-point and terminal market reports',
        ]} />
      </Entry>

      <Entry
        title="Allergies"
        kind="mixed"
        what="Removes matching recipes from plans and the shopping list, and flags any that slip through."
      >
        <p>
          The eleven groups are Canada's priority allergens — peanuts, tree nuts,
          milk, eggs, fish, crustaceans and molluscs, sesame, soy, wheat, mustard
          and sulphites. That list is a real published standard; it was reproduced
          here from knowledge of it rather than fetched.
        </p>
        <p>
          Groups rather than individual ingredients, because ticking “tree nuts”
          has to cover every nut at once — asking someone to exclude each one by
          hand is exactly how one gets missed.
        </p>
        <p>
          Built-in ingredients carry checked allergen data. Anything you import is
          additionally run through <strong>name matching</strong>, so a “cashew
          butter” with no data is still caught. Matching can only ever add a
          warning, never remove one. Where a match came from a name rather than
          checked data, the app says so.
        </p>
        <p>
          An ingredient the app does not recognise is reported as{' '}
          <strong>“cannot verify”</strong>, never as safe. Silence that looks like
          safety is the dangerous failure here.
        </p>
        <Caveat>
          This matches the ingredient list inside the app. It knows nothing about
          processing, shared equipment, “may contain” warnings, or what is inside a
          shop-bought sauce. It saves you time. It is not a safety check, and it is
          not a substitute for reading labels.
        </Caveat>
        <Refs items={[
          'Health Canada — priority food allergens, gluten sources and added sulphites',
        ]} />
      </Entry>

      <Entry
        title="Measures and money"
        kind="design"
        what="How quantities are combined, and why totals always add up."
      >
        <p>
          Everything is stored internally as <strong>grams</strong> — volumes
          converted by density, counts by a per-ingredient weight. Without one
          common unit, “2 cloves garlic” plus “1 tbsp minced garlic” plus “30 g
          garlic” cannot become a single line on a shopping list.
        </p>
        <p>
          Spoon and cup measures use the metric cooking conventions (5 ml, 15 ml,
          240 ml) rather than US customary exact values (4.93, 14.79, 236.6). The
          difference is under 2%, far below the noise in “one medium onion”, and the
          round numbers display better.
        </p>
        <p>
          <strong>Money is stored as whole cents</strong>, never as a decimal.
          Computers cannot represent most decimal fractions exactly — a tenth plus
          two tenths famously comes to 0.30000000000000004 — and a month of
          totals added that way drifts by pennies that never reconcile against a
          bank statement. Integers make that impossible rather than unlikely.
        </p>
      </Entry>

      <Entry
        title="Syncing between devices"
        kind="design"
        what="Keeps the plan and the shopping list the same on your phone and laptop."
      >
        <p>
          When two devices change the same thing, the later change wins. The
          difficulty is defining “later”, because device clocks disagree. If your
          laptop runs ten minutes fast, it would win every conflict regardless of
          what actually happened — including overwriting changes made after it.
        </p>
        <p>
          So each change carries a <strong>hybrid logical clock</strong>: real time
          plus a counter that steps forward whenever a device sees a timestamp from
          another one. After two devices have exchanged anything, a genuinely later
          change always compares later, whatever the clocks say.
        </p>
        <p>
          Deliberately not a CRDT. One household, two devices, and the worst
          realistic collision is a ticked checkbox — hundreds of lines of machinery
          to merge a boolean two devices essentially never touch at once.
        </p>
        <Caveat>
          The pairing code is the only credential. Anyone who has it can read and
          change your plans. That is a fair trade for a personal tool, and it is why
          it should hold nothing more sensitive than what you are having for dinner.
        </Caveat>
        <Refs items={[
          'Kulkarni, Demirbas, Madappa, Avva & Leone (2014), “Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases”',
        ]} />
      </Entry>

      <Entry
        title="The balance between competing goals"
        kind="design"
        what="Why the planner sometimes accepts more waste."
      >
        <p>
          Waste is the main goal, but not the only one. A plan is also scored on
          variety, seasonality, sale prices, cooking time and how recently you ate
          something. These are added together, so the planner will accept a little
          more waste to avoid, say, chicken four nights running.
        </p>
        <p>
          The relative weights were tuned by hand against the built-in library.
          They were originally much worse: variety and repetition were weighted so
          heavily that they drowned waste out entirely — the headline feature was a
          rounding error in its own scoring. They are now scaled so that one unit of
          each kind of badness costs roughly a dollar, which makes the trade-offs
          legible.
        </p>
        <Caveat>
          Still guesses. They were calibrated against 15 recipes and a synthetic
          week, not against a year of real shopping.
        </Caveat>
      </Entry>

      <Entry
        title="Week rules"
        kind="design"
        what="Why “three quick meals” is not the same as a filter."
      >
        <p>
          A filter is a fact about one recipe — it is vegetarian, it takes 25
          minutes. A rule is a fact about the week: three of them, not all of
          them. Asking a filter for “under 30 minutes” gives you a week of
          stir-fries; asking a rule for “three meals under 30 minutes” gives you
          three quick nights and four you can take your time over.
        </p>
        <p>
          Rules reach the planner as a cost rather than as a hard constraint.
          Every meal a rule is still short is charged at about twenty-five times
          what a unit of waste costs, so the search will give up almost any
          saving to satisfy one — but the cost is finite, which is what lets an
          impossible rule produce a week with one rule unmet instead of no week
          at all. That unmet rule is then named on the This week screen rather
          than swallowed.
        </p>
        <Caveat>
          The weight is a judgement, not a measurement. It is high enough that
          rules behave like requirements in every week tested, and nothing has
          been calibrated against real households.
        </Caveat>
      </Entry>

      <Entry
        title="How recipes are filed by type and region"
        kind="design"
        what="What makes a dish “pasta”, and what makes it “from Italy”."
      >
        <p>
          Neither is stored on the recipe. The kind of dish is read from the
          tags and from the ingredients, using the same list of what counts as
          pasta that the pasta grab bag draws from — which matters, because a
          good half of the pasta in the library is not tagged as pasta. Pasta e
          ceci and mac and cheese never were.
        </p>
        <p>
          Filing and filtering deliberately give different answers. A minestrone
          with ditalini in it is filed under soups, because that is what it is,
          and is still found by a search for pasta, because there is pasta in it.
          A rule asking for two pasta nights counts it.
        </p>
        <p>
          Region here means where the food is from, and has nothing to do with
          the region setting that decides what is in season where you shop.
          Cuisines are grouped into ten broad areas. Italy is one of them on its
          own, which is not geography — it is the largest cuisine in the library
          by a distance and the one people go looking for on purpose.
        </p>
        <Caveat>
          The groupings are a convenience for browsing, not a claim about
          culinary history. Several of them would be argued with, and the generic
          “asian” tag is filed under East Asia because that is the least wrong
          shelf rather than a right one.
        </Caveat>
      </Entry>

      <Entry
        title="The recipes"
        kind="estimate"
        what="The library the app ships with."
      >
        <p>
          Written for this app. They are ordinary versions of common dishes, chosen
          to overlap with each other so the planner has something to work with.
          Nothing was copied from a cookbook or a recipe site — those are
          copyrighted, and scraping them would breach most sites' terms.
        </p>
        <p>
          The library is heavily vegetarian and heavily pasta, because that is
          what it was asked to grow into. Many of the pasta dishes are variants
          of one another — the same dish with one thing swapped — which the
          planner treats as a single choice and then resolves to whichever
          version that week can buy most cheaply.
        </p>
        <p>
          Bring your own as well — the import format is documented, and the
          importer rejects anything it cannot fully resolve rather than
          importing it with holes.
        </p>
      </Entry>

      <Entry
        title="Importing from a link, a photo or text"
        kind="design"
        what="How a captured recipe is read, and what is guessed."
      >
        <p>
          Three sources, one destination. A page, a photograph and a paste all
          become the same editable draft, and that draft goes through the same
          importer as a hand-authored bundle — an ingredient that cannot be
          resolved to real grams rejects the recipe rather than entering the
          library with a hole in it.
        </p>
        <p>
          <strong>Links.</strong> Most recipe sites publish their recipes as
          schema.org structured data, because search engines require it. That is
          read as data — the author's own ingredient list and yield — rather than
          guessed at from the page text. Where a page publishes none, the text is
          parsed instead, and the review screen says so.
        </p>
        <p>
          <strong>Photos.</strong> Text recognition runs on your device using
          Tesseract; the photo is not uploaded. It reads flat, well-lit printed
          pages well and handwriting badly. A confidence figure is shown because a
          low one means retake the photo, which is something only you can do.
        </p>
        <p>
          <strong>What is guessed.</strong> Meal type, from the recipe's name.
          Servings, when the source states none — four is assumed and flagged.
          Section boundaries, when a pasted text has no headings. Every one of
          these appears on the review screen before anything is saved.
        </p>
        <Caveat>
          Quantities are never guessed. A line the parser cannot read with
          confidence is rejected and shown to you, because a mis-read quantity
          corrupts the grocery list in a way nobody notices until they are in a
          shop with the wrong food.
        </Caveat>
        <p>
          On copyright: this imports recipes into your own library on your own
          device, which is an ordinary personal use. Lists of ingredients are not
          themselves protected in most jurisdictions, though the written method
          usually is. Nothing here republishes anything, and bulk-scraping a site
          would breach most sites' terms even though this would not.
        </p>
      </Entry>

      <h3 className="section-title">If you only change one thing</h3>
      <div className="card small dim">
        Pack sizes and whether an item is sold loose drive the entire waste
        calculation. They vary by shop more than anything else here, and they are
        the fastest way to make the estimates match your actual life. Everything
        else can stay approximate.
      </div>

      <p className="tiny faint" style={{ marginTop: 16 }}>
        Written by Claude (Anthropic) while building this app. Where this page says
        a figure is an estimate, that is meant literally.
      </p>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

type EntryKind = 'design' | 'estimate' | 'mixed';

const KIND_LABEL: Record<EntryKind, string> = {
  design: 'reasoned',
  estimate: 'estimated',
  mixed: 'part standard, part estimated',
};

/**
 * One system, as a tap-to-open block.
 *
 * `<details>` rather than React state: it is the right element for the job, works
 * without JavaScript, and browsers already give it keyboard and screen-reader
 * behaviour that would otherwise have to be rebuilt by hand.
 */
function Entry({
  title, kind, what, children,
}: {
  title: string;
  kind: EntryKind;
  what: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <details className="cite">
      <summary>
        <span className="grow">
          <span className="strong">{title}</span>
          <span className="gmeta" style={{ display: 'block' }}>{what}</span>
        </span>
        <span className={`badge${kind === 'estimate' ? ' warn' : kind === 'design' ? ' accent' : ''}`}>
          {KIND_LABEL[kind]}
        </span>
      </summary>
      <div className="cite-body">{children}</div>
    </details>
  );
}

function Caveat({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="cite-caveat">{children}</p>;
}

function Refs({ items }: { items: readonly string[] }): JSX.Element {
  return (
    <>
      <div className="cite-refs-title">Where to check</div>
      <ul className="cite-refs">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </>
  );
}
