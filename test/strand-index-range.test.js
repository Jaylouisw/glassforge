'use strict';
// A strand list is indices on *the cable the span is*, not the splitter ports above it.
//
// SPEC section 6 bounds `spans[].strands` by what the cable carries, and `network.validate` refuses a
// span that lists more strands than its cable holds - but the check was the *count* of entries against
// `fiberCount`, and a count cannot see a value. Measured on main before this suite:
//
//   `strands: [99]` on a g652d-loose-12 answered `validate` clean, `/strands` said "1 of 12 used,
//   11 spare", and the splice sheet printed `T09-F03` - tube 9 of a single-tube 12-fibre cable, a
//   tray position that does not exist. `[13]` printed `T02-F01`; `[0]`, `[-1]`, `[1.5]` and `['a']`
//   were counted as one strand used in the tab while the sheet silently dropped them, so the two
//   surfaces disagreed about the same span.
//
// api-ops-validation.test.js already states the intent: "a 1-fibre drop would be a span listing more
// strands than its cable carries - overbooked, and refused by the save gate". A 1-fibre drop listing
// `[8]` passed because 8 is one entry. This suite reads the value as well as the count.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();

function range(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

/** OLT - closure - ONT, with the first span carrying `strands` on `cable`. */
function plant(strands, opts) {
  const o = opts || {};
  const span = { id: 's1', from: 'n1', to: 'n2', cable: o.cable || 'g652d-loose-12', lengthM: 300 };
  if (strands !== undefined) span.strands = strands;
  if (o.bundles !== undefined) span.bundles = o.bundles;
  return {
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'closure', model: 'mufa-inline-24', lat: 51.5005, lon: -0.1 },
      { id: 'n3', type: 'ont', model: 'gpon-ont-4ge', lat: 51.501, lon: -0.1 }
    ],
    spans: [span, { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40, strands: [1] }]
  };
}

test('a strand index past the cable is refused by name, not counted as free capacity', function () {
  // 13 on a 12-fibre cable: one entry, one strand that does not exist on the drum.
  const ledger = engine.network.strandLedger(plant([13]), registry);
  const row = ledger.rows[0];
  assert.strictEqual(row.used, 0, 'no strand of the cable is in use');
  assert.strictEqual(row.spare, 12);
  assert.strictEqual(row.overbooked, true, '13 strands on a 12-fibre cable is over the cable');
  assert.deepStrictEqual(row.invalid, [13]);
  assert.strictEqual(row.error,
    'span "s1" lists strand 13, beyond the 12 strands its 12-fibre cable carries');

  const result = engine.network.validate(plant([13]), registry);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.errors, [row.error], 'the gate quotes the ledger, as for overbooking');
});

test('the set of strands it cannot carry is reachable as far as the count is', function () {
  // 99 was the worst case: `T09-F03` on a one-tube cable, and 11 strands reported spare beside it.
  const row = engine.network.strandLedger(plant([99]), registry).rows[0];
  assert.deepStrictEqual(row.invalid, [99]);
  assert.strictEqual(row.used, 0);
  assert.strictEqual(row.spare, 12);
  assert.ok(row.error.indexOf('strand 99') !== -1, row.error);
  assert.ok(row.error.indexOf('12-fibre cable') !== -1, row.error);
});

test('the established overbooked sentence still wins when the count itself overruns', function () {
  // range(13) already had a test (strand-overbooking-gate); its wording must not change under the
  // new check, and the thirteenth strand is reported as the entry it is.
  const row = engine.network.strandLedger(plant(range(13)), registry).rows[0];
  assert.strictEqual(row.overbooked, true);
  assert.strictEqual(row.used, 12, 'twelve real strands; the thirteenth is not one');
  assert.deepStrictEqual(row.invalid, [13]);
  assert.strictEqual(row.error, 'span "s1" uses 13 strands of a 12-fibre cable');
  assert.deepStrictEqual(engine.network.validate(plant(range(13)), registry).errors, [row.error]);
});

test('a bundle carries every cable, so its strands run to fiberCount x bundles', function () {
  // Auto-design writes bundles: 2 for a span whose fibres do not fit one cable. Strand 13 is the
  // second cable's first strand and is carried; strand 25 is past both.
  const ok = engine.network.strandLedger(plant([13], { bundles: 2 }), registry).rows[0];
  assert.strictEqual(ok.used, 1);
  assert.deepStrictEqual(ok.invalid, []);
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(engine.network.validate(plant([13], { bundles: 2 }), registry).ok, true);

  const over = engine.network.strandLedger(plant([25], { bundles: 2 }), registry).rows[0];
  assert.deepStrictEqual(over.invalid, [25]);
  assert.strictEqual(over.error,
    'span "s1" lists strand 25, beyond the 24 strands its 2 x 12-fibre cables carry');
});

test('an entry that is not a strand number is refused, and named as itself', function () {
  // The tab counted `'x'` as one strand in use while the sheet dropped it: two answers, one span.
  const row = engine.network.strandLedger(plant(['x', 0, 1.5, 3]), registry).rows[0];
  assert.strictEqual(row.used, 1, 'only strand 3 is a strand');
  assert.strictEqual(row.spare, 11);
  assert.deepStrictEqual(row.invalid, ['x', 0, 1.5]);
  assert.ok(row.error.indexOf('"x"') !== -1, 'names the value: ' + row.error);
  assert.ok(row.error.indexOf('0') !== -1, row.error);
  assert.ok(row.error.indexOf('1.5') !== -1, row.error);
  assert.strictEqual(row.overbooked, false, 'three bad entries are not three strands of the cable');
});

test('a strand number written as text is the strand it names, once', function () {
  // The splice sheet already converts with Number(); the ledger used a Set of raw values, so
  // ['7', 7] was two strands in the tab and one row on the sheet.
  const row = engine.network.strandLedger(plant(['7', 7]), registry).rows[0];
  assert.strictEqual(row.used, 1);
  assert.deepStrictEqual(row.invalid, []);
  assert.strictEqual(row.error, undefined);
});

test('the splice sheet never addresses a strand the cable cannot carry', function () {
  // A 1-fibre drop listing two strands printed `T01-F02`; the sheet now drops it, as it already
  // dropped 0, 1.5 and 'x'. The sheet is not gated here - it has to survive a stored project that
  // predates the gate, and a row for a tube the cable does not have is worse than no row.
  const one = plant([1]);
  const drop = one.spans.find(function (s) { return s.id === 's2'; });
  drop.strands = [1, 2]; // a 1-fibre drop with a second strand listed: T01-F02 does not exist
  const table = engine.network.spliceTable(one, registry);
  const dropRows = table.points[0].rows.filter(function (r) { return r.span === 's2'; });
  assert.deepStrictEqual(dropRows.map(function (r) { return r.strand; }), [1]);

  const ribbon = plant([25], { cable: 'g652d-ribbon-216' });
  const rows = engine.network.spliceTable(ribbon, registry).points[0].rows;
  const at25 = rows.find(function (r) { return r.strand === 25; });
  assert.ok(at25, 'a 216-fibre ribbon carries strand 25');
  assert.strictEqual(at25.address, 'T03-F01', '12 per tube: strand 25 is tube 3, fibre 1');
});


test('a one-fibre drop reads as one strand, and a second entry is refused', function () {
  // The sentence has to stay readable at the smallest cable: "the 1 strands" is how a boundary
  // written for a feeder reads on a drop.
  const p = plant([1]);
  const drop = p.spans.find(function (s) { return s.id === 's2'; });
  drop.strands = [2];
  const row = engine.network.strandLedger(p, registry).rows[1];
  assert.strictEqual(row.error,
    'span "s2" lists strand 2, beyond the 1 strand its 1-fibre cable carries');
  assert.deepStrictEqual(engine.network.validate(p, registry).errors, [row.error]);
});

done();
