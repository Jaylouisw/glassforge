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

const DEFAULTS = {
  overlengthPct: 3,
  spliceReserveM: 30,
  closureReserveM: 20,
  drumM: 2000
};

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 1 : places);
  return Math.round(n * f) / f;
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
  if (!isNum(o.routeM) || o.routeM < 0) throw new TypeError('routeM is required and must be a non-negative number');

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
    spliceReserveM: spliceReserveTotalM,
    closures: closures,
    closureReserveM: closureReserveTotalM,
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

/** Same calculation, starting from a freshly drawn route on a map. */
function cableToBuyForRoute(points, opts) {
  if (!Array.isArray(points)) throw new TypeError('points must be an array of { lat, lon }');
  const routeM = geo.pathLengthM(points);
  return cableToBuy(Object.assign({}, opts || {}, { routeM: routeM }));
}

/**
 * Bill of materials for a whole plant: one cable line per span, reserves applied per span, then
 * aggregated per cable model and per drum. A span with no measured length is an error, not a zero:
 * the BOM is the number someone spends money against.
 */
function billOfMaterials(plant, registry, opts) {
  const o = opts || {};
  if (!plant || !Array.isArray(plant.spans)) throw new TypeError('billOfMaterials needs a plant with spans');
  // Resolved once, here, so a plant with no spans still refuses a minimum that is not a number
  // instead of quietly returning an empty BOM that never looked at it.
  const minimumPurchaseM = nonNegative(o.minimumPurchaseM, 'minimumPurchaseM', 0);
  const byModel = new Map();
  const lines = [];

  plant.spans.forEach(function (span, i) {
    const cable = registry.get('cable', span.cable);
    if (!isNum(span.lengthM) || span.lengthM <= 0) {
      throw new Error('span ' + (span.id || '#' + i) + ' has no measured length - measure the route before building a BOM');
    }
    const splices = span.splices === undefined ? 0 : span.splices;
    const closures = span.closures === undefined ? 0 : span.closures;
    const calc = cableToBuy({
      routeM: span.lengthM,
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
      routeM: calc.routeM,
      designM: calc.designM
    });
    const prev = byModel.get(cable.model) || { model: cable.model, label: cable.label, fiberCount: cable.fiberCount, designM: 0, drumM: cable.drumM || o.drumM || 0, lengths: 0 };
    prev.designM = round(prev.designM + calc.designM, 2);
    prev.lengths += 1;
    byModel.set(cable.model, prev);
  });

  // Drums are rounded ONCE per cable model, on the total design length. Rounding per span and
  // adding the drums up buys a spare drum for every short run on the map.
  const byCable = Array.from(byModel.values()).map(function (row) {
    const drumM = row.drumM || 0;
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
