'use strict';
/**
 * How much cable to buy.
 *
 * The number that goes on the purchase order is never the number the map measures. A route drawn
 * over a street is the *straight* length between bends; the cable that gets pulled has to climb
 * poles, follow a duct's actual path, and be long enough to reach a splice tray and back out again.
 * The allowances here are the ones an FTTH planner applies, each one named and separable:
 *
 *   design length = route + overlength% + splice reserves + closure reserves + drops
 *
 * and then the purchase is rounded up to whole drums, because cable is sold by the drum.
 *
 * Every term is reported as its own line. A BOM whose total is 248 m and whose justification is
 * "trust me" is exactly the number a site engineer will over-order against.
 */

const geo = require('./geo');
const network = require('./network');
const designFields = require('./design-fields');

const DEFAULTS = {
  overlengthPct: 3,
  spliceReserveM: 30,
  closureReserveM: 20,
  drumM: 2000
};

/**
 * The nine options a cable calculation reads - and a near miss of one is refused by name.
 *
 * The answer here is a purchase order, so a key the calculation does not read is the worst kind of
 * typo: it removes a term without removing a number from the order. Measured on this engine before
 * the guard, on `routeM: 1000`:
 *
 *   `{"overlengthpct": 10}`  answered `designM` 1030, the 3% default - 70 m of the overlength the
 *                            caller named, missing from the order;
 *   `{"drumm": 500}`         priced the 2000 m drum, so 2000 m were bought where 3 x 500 m was asked,
 *                            and the line read "Purchase (1 x 2000 m drum)";
 *   `{"closure": 2}`         (singular) dropped both 20 m closure reserves, 40 m short.
 *
 * The budget endpoints have refused a near-miss field by name since #137 and #192; this is the same
 * narrow rule - case, singular/plural, a prefix, one letter or a unit slip - at the one endpoint whose
 * answer is money. A key that is not near a field it reads (`name`, `notes`, `points`, `network`) is
 * still ignored, so a caller's own bookkeeping and the drawn-route form's own keys pass through.
 */
const OPTION_FIELDS = ['routeM', 'overlengthPct', 'splices', 'spliceReserveM', 'closures',
  'closureReserveM', 'dropReserveM', 'drumM', 'minimumPurchaseM'];

/**
 * The five options `billOfMaterials` reads for itself - and the wording its refusal uses.
 *
 * Same rule, one layer up. The BOM used to hand these five to `cableToBuy` in a fresh object with
 * every key spelled correctly, so the guard there could never see the caller's typo: measured on
 * `main` at c3ebcc3, one 1000 m span of g652d-loose-12 with two splices answered `designM` 1090 (the
 * 3% default) for `{"overlengthpct": 10}`, bought 2000 m for `{"minimumPurchase": 5000}`, and
 * dropped both 30 m reserves for `{"spliceReserves": 5}`. `drumM` is accepted although a cable that
 * states its own drum wins (`cable.drumM || o.drumM`): it is the fallback for a cable that states
 * none, which is a live path, not an option the BOM ignores.
 *
 * A single adjacent transposition (`{"overlenghtPct": 10}`) is refused by the same matcher: a swap
 * is one keystroke, so it is one edit, and the BOM does not buy the 3% default instead.
 */
const BOM_OPTION_FIELDS = ['overlengthPct', 'spliceReserveM', 'closureReserveM', 'drumM',
  'minimumPurchaseM'];

const PURCHASE_NEAR_MISS = {
  noun: 'option',
  consequence: 'A term the calculation ignores buys cable without the metres it names, so a near ' +
    'miss is refused rather than skipped.'
};

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 1 : places);
  return Math.round(n * f) / f;
}

/**
 * Why a measured length is not a length, in the words the caller needs.
 *
 * Two answers both round to 0.00 m and are different mistakes: a route whose points are all in one
 * place was not drawn across the ground, and a route a few millimetres long was drawn but cannot be
 * quoted at the 2 dp this calculation rounds to. Below a tenth of a millimetre even the printed
 * figure reads zero, so the sentence says the length is under the floor rather than claiming it
 * measured 0 m.
 */
function unmeasuredWhy(measuredM) {
  if (measuredM === 0) return 'every point is in the same place';
  const shown = round(measuredM, 4);
  return shown > 0
    ? 'it measures ' + shown + ' m, which rounds to 0.00 m'
    : 'it measures under 0.0001 m, which rounds to 0.00 m';
}

function nonNegative(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!isNum(value) || value < 0) throw new TypeError(field + ' must be a non-negative number, got ' + value);
  return value;
}

/**
 * The purchase, in whole drums.
 *
 * Cable is sold by the drum, so a purchase is always a whole number of them - which means a supplier
 * minimum, stated in metres, is a floor that has to be *lifted* to the next whole drum rather than
 * taken literally. Taking it literally produced a line reading "Purchase (1 x 2000 m drum)" with a
 * total of 5000 m: a label and a number that disagree on what goes on the order, which is the one
 * thing a BOM line cannot do.
 *
 * `drumM: 0` means the cable is bought by the metre (a cut reel), so there is no drum to round and the
 * floor is the plain maximum. Both `cableToBuy` and `billOfMaterials` call this: the second used to do
 * its own rounding and never read the minimum at all, quoting a purchase below a supplier's floor.
 */
function purchaseOf(designM, drumM, minimumPurchaseM) {
  if (!(drumM > 0)) {
    const purchaseM = round(Math.max(designM, minimumPurchaseM), 2);
    return { drums: 0, purchaseM: purchaseM, spareM: round(purchaseM - designM, 2) };
  }
  let drums = Math.ceil(designM / drumM);
  if (drums * drumM < minimumPurchaseM) drums = Math.ceil(minimumPurchaseM / drumM);
  const purchaseM = round(drums * drumM, 2);
  return { drums: drums, purchaseM: purchaseM, spareM: round(purchaseM - designM, 2) };
}

/**
 * Itemised cable requirement.
 *
 * opts:
 *   routeM              measured route length (required)
 *   overlengthPct       slack for terrain and pulling        (default 3%)
 *   splices             splice count                         (reserve per splice, default 30 m)
 *   spliceReserveM      reserve per splice                   (default 30)
 *   closures            closure/box count                    (default 0)
 *   closureReserveM     reserve per closure                  (default 20)
 *   dropReserveM        explicit additional reserve          (default 0)
 *   drumM               drum length                          (default 2000)
 *   minimumPurchaseM    floor, e.g. a supplier's minimum     (default 0)
 */
function cableToBuy(opts) {
  const o = opts || {};
  // Before the route is read, because a typo is the cause and "routeM is required" would be the
  // symptom: a caller who sent `routeKM` has a route, just not in a unit this reads.
  designFields.assertKnownFields(o, OPTION_FIELDS, 'the cable calculation', PURCHASE_NEAR_MISS);
  if (!isNum(o.routeM) || o.routeM < 0) throw new TypeError('routeM is required and must be a non-negative number');
  // gh#164. `routeM: 0` is a figure the caller measured - 0 m of route is 0 m of cable, and reserves
  // are priced against it - but a *positive* route that rounds to 0.00 m is a route this answer
  // cannot express. Measured on 19269af: `cableToBuy({ routeM: 0.004 })` answered `drums: 0` with a
  // line reading "Purchase (0 x 2000 m drum)", the same purchase order for nothing gh#151 refused on
  // the drawn-route form. The two doors left open were this one and the BOM's, and both are shut
  // here and in `billOfMaterials` with the sentence the drawn form already used.
  if (o.routeM > 0 && round(o.routeM, 2) <= 0) {
    const shown = round(o.routeM, 4);
    throw new TypeError('routeM ' + (shown > 0 ? shown + ' m' : 'is under 0.0001 m and') +
      ' rounds to 0.00 m. A route that cannot be measured is not a purchase of 0 m: a sub-centimetre ' +
      'route is a unit slip (metres sent as kilometres) or a route that was never drawn, so measure it again');
  }

  const overlengthPct = nonNegative(o.overlengthPct, 'overlengthPct', DEFAULTS.overlengthPct);
  const spliceReserveM = nonNegative(o.spliceReserveM, 'spliceReserveM', DEFAULTS.spliceReserveM);
  const closureReserveM = nonNegative(o.closureReserveM, 'closureReserveM', DEFAULTS.closureReserveM);
  const drumM = nonNegative(o.drumM, 'drumM', DEFAULTS.drumM);
  const minimumPurchaseM = nonNegative(o.minimumPurchaseM, 'minimumPurchaseM', 0);

  let splices = 0;
  if (Array.isArray(o.splices)) splices = o.splices.length;
  else if (isNum(o.splices)) {
    if (!Number.isInteger(o.splices) || o.splices < 0) throw new TypeError('splices must be a non-negative integer or an array');
    splices = o.splices;
  } else if (o.splices !== undefined) throw new TypeError('splices must be a number or an array');

  let closures = 0;
  if (Array.isArray(o.closures)) closures = o.closures.length;
  else if (isNum(o.closures)) {
    if (!Number.isInteger(o.closures) || o.closures < 0) throw new TypeError('closures must be a non-negative integer or an array');
    closures = o.closures;
  } else if (o.closures !== undefined) throw new TypeError('closures must be a number or an array');

  const dropReserveM = nonNegative(o.dropReserveM, 'dropReserveM', 0);

  const routeM = round(o.routeM, 2);
  const overlengthM = round(routeM * (overlengthPct / 100), 2);
  const spliceReserveTotalM = round(splices * spliceReserveM, 2);
  const closureReserveTotalM = round(closures * closureReserveM, 2);
  const designM = round(routeM + overlengthM + spliceReserveTotalM + closureReserveTotalM + dropReserveM, 2);

  const purchase = purchaseOf(designM, drumM, minimumPurchaseM);
  const drums = purchase.drums;
  const purchaseM = purchase.purchaseM;
  const spareM = purchase.spareM;

  const lines = [
    { label: 'Route (measured on the map)', m: routeM },
    { label: 'Overlength ' + overlengthPct + '%', m: overlengthM },
    { label: 'Splice reserve (' + splices + ' x ' + spliceReserveM + ' m)', m: spliceReserveTotalM },
    { label: 'Closure reserve (' + closures + ' x ' + closureReserveM + ' m)', m: closureReserveTotalM }
  ];
  if (dropReserveM > 0) lines.push({ label: 'Additional reserve', m: round(dropReserveM, 2) });
  lines.push({ label: 'Design length', m: designM, total: true });
  if (drumM > 0) {
    lines.push({ label: 'Purchase (' + drums + ' x ' + drumM + ' m drum)', m: purchaseM, total: true });
    lines.push({ label: 'Spare on site', m: spareM });
  }

  return {
    routeM: routeM,
    overlengthPct: overlengthPct,
    overlengthM: overlengthM,
    splices: splices,
    // The rate, not the total. These two keys are what the caller sets (`spliceReserveM: 30` means
    // 30 m per splice), so the answer has to echo the same quantity under the same name or the
    // response cannot be fed back: it used to return 2 x 30 = 60 under `spliceReserveM`, and
    // re-sending that answer doubled the reserve (designM 1150 -> 1330 on a 1 km route). The totals
    // carry their own names, the way `overlengthPct` (rate) and `overlengthM` (total) already did.
    spliceReserveM: spliceReserveM,
    spliceReserveTotalM: spliceReserveTotalM,
    closures: closures,
    closureReserveM: closureReserveM,
    closureReserveTotalM: closureReserveTotalM,
    dropReserveM: round(dropReserveM, 2),
    minimumPurchaseM: minimumPurchaseM,
    designM: designM,
    drumM: drumM,
    drums: drums,
    purchaseM: purchaseM,
    spareM: spareM,
    lines: lines
  };
}

/**
 * Same calculation, starting from a freshly drawn route on a map.
 *
 * A route is measured *between* coordinates, so a route that cannot be measured is not a short route
 * - and it is certainly not a purchase of zero metres. `pathLengthM` answers 0 for fewer than two
 * points on purpose (it is geometry, and a single point has no length); through this function that 0
 * became a BOM the caller could spend: `POST /api/design/length {"points":[]}` answered 200 with
 * `routeM: 0, drums: 0, purchaseM: 0`, and a route of one point did the same. `billOfMaterials`
 * already refuses a span with no measured length for this reason; this is the same refusal on the
 * drawn-route form, naming what a route needs.
 *
 * A route that has the points but measures nothing - every tap on the same spot - is the same answer
 * one step further in: measured on 03a7f81, `{"points":[{"lat":52,"lon":4},{"lat":52,"lon":4}]}`
 * answered 200 with `routeM: 0, drums: 0, purchaseM: 0`, because the count guard above only caught a
 * route too short to have points. A drawn route with no length is refused by what it measured, and a
 * route whose measured length rounds away (four millimetres) is refused by that figure rather than
 * priced as 0.00 m, for the same reason `billOfMaterials` refuses a span with no measured length.
 *
 * A point the route cannot place is refused by its index. `distanceM` checks both ends of a segment
 * and says "distanceM needs two { lat, lon } coordinates", which names an internal function, no
 * position and no file - on an imported 40-point route that is a hunt. The empty cell is the classic
 * one: `Number('')` is 0, so `{"lat":"","lon":""}` reads as a coordinate unless it is tested as a
 * raw value, and at lat 0, lon 0 it would measure a route across the Gulf of Guinea.
 */
function cableToBuyForRoute(points, opts) {
  if (!Array.isArray(points)) throw new TypeError('points must be an array of { lat, lon }');
  if (points.length < 2) {
    throw new TypeError('a route needs at least two { lat, lon } points to measure - got ' + points.length +
      '. A route with no measurable length is not a purchase of 0 m: draw the route, or send `routeM` directly');
  }
  for (let i = 0; i < points.length; i++) {
    if (geo.isCoordinate(points[i])) continue;
    throw new TypeError('route point ' + i + ' is not a { lat, lon } coordinate - got ' +
      JSON.stringify(points[i]) + '. Every point is measured, so a point the route cannot place is ' +
      'refused rather than skipped: skipping it would shorten the cable without shortening the plan');
  }
  const measuredM = geo.pathLengthM(points);
  // A route that measures nothing is not measured - two taps on one spot are a route the caller drew
  // and a length of 0.00 m, and the purchase that came out of it was zero drums of cable. The two
  // clauses are told apart because they are different mistakes: coincident points say the route was
  // not drawn across the ground, and a sub-centimetre route says the figure the calculation rounds
  // to is zero.
  if (round(measuredM, 2) <= 0) {
    // Printed to four places, and below that floor it says so: a route 0.011 mm long is not
    // "0 m", and a sentence whose two clauses both read zero explains nothing.
    throw new TypeError('the drawn route has no measurable length - ' + unmeasuredWhy(measuredM) +
      '. A route that cannot be measured is not a purchase of 0 m: draw it across the ground, or send `routeM` directly');
  }
  return cableToBuy(Object.assign({}, opts || {}, { routeM: measuredM }));
}

/**
 * Bill of materials for a whole plant: one cable line per span, reserves applied per span, then
 * aggregated per cable model and per drum. A span with no measured length is an error, not a zero:
 * the BOM is the number someone spends money against.
 */
function billOfMaterials(plant, registry, opts) {
  const o = opts || {};
  // Before the plant is read, because a typo is the cause and "needs a plant with spans" would be the
  // symptom: the caller who sent `minimumPurchase` has a plant, just a purchase below the floor they
  // named. Same narrow rule and same words as the cable page, since both answers are a purchase order.
  designFields.assertKnownFields(o, BOM_OPTION_FIELDS, 'the bill of materials', PURCHASE_NEAR_MISS);
  if (!plant || !Array.isArray(plant.spans)) throw new TypeError('billOfMaterials needs a plant with spans');
  // Resolved once, here, so a plant with no spans still refuses a minimum that is not a number
  // instead of quietly returning an empty BOM that never looked at it.
  const minimumPurchaseM = nonNegative(o.minimumPurchaseM, 'minimumPurchaseM', 0);
  const byModel = new Map();
  const lines = [];

  plant.spans.forEach(function (span, i) {
    // A BOM is a purchase order, so it cannot price an entry it cannot read - and it must not skip
    // it either (a skipped span is a drum nobody orders). Measured: a project file holding `null`
    // among its spans answered `500 Cannot read properties of null (reading 'cable')` out of
    // `/api/projects/:id/bom` and out of the printed plan, where the file was the caller's own.
    if (!network.isEntry(span)) {
      throw new Error('span #' + i + ' is not a span object - the bill of materials prices objects ' +
        'with an id, a cable and a length in metres');
    }
    const cable = registry.get('cable', span.cable);
    if (!isNum(span.lengthM) || span.lengthM <= 0) {
      throw new Error('span ' + (span.id || '#' + i) + ' has no measured length - measure the route before building a BOM');
    }
    const splices = span.splices === undefined ? 0 : span.splices;
    const closures = span.closures === undefined ? 0 : span.closures;
    // A span is one route, not always one cable: `bundles` is how many cables run it, set by
    // auto-design when the span's fibres do not fit the largest cable in the ladder. The purchase is
    // every cable it pulls - reading the map length once bought half the cable for a 160-fibre trunk,
    // and the design that produced the plant had already ranked it on both. Absent means one cable; a
    // count that is not a positive whole number is refused by name, never read as one or as zero.
    const bundles = span.bundles === undefined ? 1 : span.bundles;
    if (!network.isBundleCount(bundles)) {
      throw new Error('span "' + (span.id || '#' + i) + '" has an invalid bundles count "' +
        String(span.bundles) + '" - a span runs one whole cable or more');
    }
    // gh#164. The check above refuses a span with no length at all; a span longer than 0 but shorter
    // than half a centimetre passed it and was priced at zero: on 19269af a 0.004 m span answered a
    // line reading `{ routeM: 0, designM: 0 }` and a row reading `drums: 0, purchaseM: 0`, so the
    // trace-back line disagreed with the map it is there to explain. Refused by the figure it
    // measured, the way the drawn-route form refuses one that rounds away.
    const spanRouteM = span.lengthM * bundles;
    if (round(spanRouteM, 2) <= 0) {
      const shown = round(spanRouteM, 4);
      throw new Error('span "' + (span.id || '#' + i) + '" measures ' +
        (shown > 0 ? shown + ' m' : 'under 0.0001 m') +
        ', which rounds to 0.00 m - a span that cannot be measured is not a purchase of 0 m: ' +
        'measure the route before building a BOM');
    }
    const calc = cableToBuy({
      routeM: round(spanRouteM, 2),
      overlengthPct: o.overlengthPct,
      splices: splices,
      spliceReserveM: o.spliceReserveM,
      closures: closures,
      closureReserveM: o.closureReserveM,
      dropReserveM: span.dropReserveM,
      drumM: cable.drumM || o.drumM,
      minimumPurchaseM: minimumPurchaseM
    });
    // Metres only. A span line is here to trace the aggregate back to the map; the drum count and the
    // purchase belong to the per-model row below, because rounding each span would buy a drum per run.
    // (This line used to carry `drums`/`purchaseM`/`spareM` computed per span, so two 500 m runs of one
    // cable read as "1 drum, 2000 m bought" each while the model line correctly said one drum.)
    lines.push({
      span: span.id || '#' + i,
      from: span.from,
      to: span.to,
      cable: cable.model,
      fiberCount: cable.fiberCount,
      bundles: bundles,
      // The measured route, so the line still traces back to the map; `designM` is what is bought,
      // which covers every cable in the bundle.
      routeM: round(span.lengthM, 2),
      designM: calc.designM
    });
    // The row carries the drum the span calculation actually used (`calc.drumM`: the cable's, then
    // the caller's, then the 2000 m default), never a re-derived `cable.drumM || o.drumM || 0`:
    // that turned "no drum stated anywhere" - the two indoor rows publish none on purpose - into 0,
    // which `purchaseOf` reads as a cut reel, so the row bought exactly the design metres while the
    // span calculation beside it and the design's cost had both priced 2000 m drums (gh#107).
    const prev = byModel.get(cable.model) || { model: cable.model, label: cable.label, fiberCount: cable.fiberCount, designM: 0, drumM: calc.drumM, lengths: 0 };
    prev.designM = round(prev.designM + calc.designM, 2);
    prev.lengths += 1;
    byModel.set(cable.model, prev);
  });

  // Drums are rounded ONCE per cable model, on the total design length. Rounding per span and
  // adding the drums up buys a spare drum for every short run on the map.
  const byCable = Array.from(byModel.values()).map(function (row) {
    // Resolved by the span calculation, default included: a cable with no drum and a caller with no
    // `drumM` is the engine's 2000 m assumption, and the row says so rather than claiming 0.
    const drumM = row.drumM;
    // The same purchase arithmetic as a single route, including the supplier minimum: two definitions
    // of "how many drums" is how the BOM came to quote less than the floor it was given.
    const purchase = purchaseOf(row.designM, drumM, minimumPurchaseM);
    return {
      model: row.model,
      label: row.label,
      fiberCount: row.fiberCount,
      designM: row.designM,
      lengths: row.lengths,
      drumM: drumM,
      drums: purchase.drums,
      purchaseM: purchase.purchaseM,
      spareM: purchase.spareM
    };
  }).sort(function (a, b) { return a.model < b.model ? -1 : 1; });

  return { lines: lines, byCable: byCable, spanCount: lines.length };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  cableToBuy: cableToBuy,
  cableToBuyForRoute: cableToBuyForRoute,
  billOfMaterials: billOfMaterials
};
