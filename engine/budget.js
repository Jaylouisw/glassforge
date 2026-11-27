'use strict';
/**
 * Optical budgets: the arithmetic that decides whether a design lights.
 *
 * Two kinds of link, one loss model:
 *
 *   PON     OLT ── splitter(s) ── ONT      `opticalBudget`
 *   active  optic ────────────── optic     `pointToPoint`
 *
 * Both are the same sum — fibre + splices + connectors + splitters + allowance — charged against a
 * receiver. What differs is where the ends get their figures from and what the second verdict means:
 * a PON is held to its ITU-T class budget (28/32/35 dB), while an active link is held to the loss its
 * own pair of transceivers can afford (`launch − sensitivity`). Keeping both in one file is what stops
 * them drifting into two definitions of "loss".
 *
 * Three things make this more than a subtraction:
 *
 * 1. **The loss is wavelength-specific.** 1490 nm downstream and 1310 nm upstream attenuate
 *    differently through the same glass. A cable that does not publish the window being asked for is
 *    an error - never a silent zero.
 * 2. **Two verdicts, not one.** The receiver has to see enough power (`headroomDb` above sensitivity)
 *    *and* the plant has to stay inside the budget the technology allows (`classHeadroomDb`). A link
 *    can pass the first and fail the second.
 * 3. **A design margin is not optional.** A network that computes to 0.2 dB of headroom does not work
 *    in the rain; `marginDb` (default 3) is the design reserve.
 */

const partsModule = require('./parts');
const designFields = require('./design-fields');

const DEFAULT_SPLICE_MODEL = 'fusion';
const DEFAULT_CONNECTOR_MODEL = 'sc-apc';
const DEFAULT_MARGIN_DB = 3;
const DEFAULT_WAVELENGTH = { down: '1490', up: '1310' };

/**
 * The carriers a PON actually has, per direction: the OLT launches downstream at 1490 nm (1550 nm
 * for an RF video overlay) and the ONT launches upstream at 1310 nm.
 *
 * `wavelength` used to be read independently of `direction`, so any of the three was accepted in
 * either one and an *upstream* verdict could be computed at a downstream wavelength - a figure for a
 * link no PON has, on an answer labelled "Upstream". It is not a rounding difference: the same 16 km
 * GPON B+ plant through a 1:64 is `fail` upstream at 1310 nm (ODN 27.10 dB, headroom 1.40 dB against
 * a 3 dB margin) and `marginal` labelled 1550 nm (ODN 24.86 dB, headroom 3.64 dB), because 16 km of
 * G.652.D attenuates 5.60 dB at 1310 and 3.36 dB at 1550. The loss is wavelength-specific, so a pair
 * no PON carries is refused by name - the rule `pointToPoint` already applies to an optic ("a link is
 * budgeted at the wavelength it transmits on").
 */
const PON_WAVELENGTH_BY_DIRECTION = { down: ['1490', '1550'], up: ['1310'] };

/**
 * Refuse a PON budget whose `wavelength` and `direction` do not describe a link, and a wavelength
 * the budget cannot read.
 *
 * Absent is absent (`null` means "not set" everywhere else in this model, and the default per
 * direction is documented and echoed), but a value that is *present and unusable* used to fall
 * through `design.wavelength || DEFAULT_WAVELENGTH[direction]`: an empty form cell became 1490 nm
 * and a `0` became 1490 nm, answered `200` with the default echoed, so the caller never learned the
 * field they sent was not read. `/api/projects/:id/budget` calls this once, before any ONT is
 * budgeted, so an impossible pair is one 400 naming the rule rather than a row repeating it.
 */
function assertPonWavelength(design) {
  const direction = design.direction === 'up' ? 'up' : 'down';
  const raw = design.wavelength;
  if (raw === undefined || raw === null) return;
  const wavelength = String(raw);
  if (partsModule.WAVELENGTHS.indexOf(wavelength) === -1) {
    throw new Error('unknown wavelength "' + wavelength + '" - expected one of ' + partsModule.WAVELENGTHS.join(', '));
  }
  const legal = PON_WAVELENGTH_BY_DIRECTION[direction];
  if (legal.indexOf(wavelength) !== -1) return;
  const label = direction === 'up' ? 'upstream' : 'downstream';
  throw new Error(label + ' is budgeted at ' +
    (legal.length > 1 ? legal.join(' or ') : legal[0]) + ' nm, not ' + wavelength +
    ' nm - a PON transmits downstream at 1490 nm (or 1550 for an RF overlay) and upstream at 1310 nm, ' +
    'so an ODN measured at ' + wavelength + ' nm in the ' + label +
    ' direction describes a link that does not exist');
}

/**
 * The fields each budget entry point reads, for `design-fields.assertKnownFields`.
 *
 * A field this engine does not read is a near miss the caller meant to type - a singular `splitter`
 * removes 10.5 dB of splitter loss from a 1:8 ODN without a warning and still answers `200` - so the
 * two lists are kept next to the code that reads them and a test asserts every name is read here.
 */
const PON_DESIGN_FIELDS = ['direction', 'wavelength', 'olt', 'ont', 'spans', 'splices', 'spliceModel',
  'connectors', 'connectorModel', 'splitters', 'thirdParty', 'allowanceDb', 'marginDb', 'txDbm'];
const ACTIVE_DESIGN_FIELDS = ['direction', 'wavelength', 'headEnd', 'cpe', 'spans', 'splices', 'spliceModel',
  'connectors', 'connectorModel', 'thirdParty', 'allowanceDb', 'marginDb', 'txDbm'];
// The **project** budget (`network.designForOnt` as the server calls it) is not handed a design: it
// builds the spans, splices and connectors from the plant it traced, and reads only these knobs off the
// request body. `ontId` is the server's own narrowing key, not a budget field, and is listed because a
// body carrying it is not a typo. Kept separate from the two design lists for the same reason they are
// separate from each other: a near miss is refused against the fields the reader really reads.
const PROJECT_BUDGET_FIELDS = ['ontId', 'direction', 'wavelength', 'spliceModel', 'connectorModel',
  'marginDb', 'allowanceDb', 'txDbm'];

/**
 * The keys a leased segment is measured through at the budget, and the two a caller may carry in from
 * a link request. A near miss of one is refused, for the reason `design-fields.ts` states: a key the
 * engine does not read is not a setting, and on a segment it is the worst kind - the lease silently
 * leaves the path it was written on.
 *
 * `leg` is deliberately **not** listed. A link scopes a lease to one leg of a circuit; a budget is one
 * ODN path, so the key has nothing to scope. Reading it as absent is what the budget used to do, which
 * told a caller their lease was on one leg when the whole path paid for it - so it is refused by name
 * below rather than ignored. `cost` and `reference` are listed because a segment lifted from a
 * `/api/design/link` body carries them and neither moves a budget.
 */
const THIRD_PARTY_FIELDS = ['provider', 'lengthM', 'lossDb', 'cost', 'reference'];

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 2 : places);
  return Math.round(n * f) / f;
}

function cableAttenuation(cable, wavelength) {
  const wl = String(wavelength);
  const att = cable.attenuationDbPerKm || {};
  const value = att[wl];
  if (!isNum(value)) {
    const known = Object.keys(att).sort();
    throw new Error('cable "' + cable.model + '" publishes no attenuation at ' + wl + ' nm' +
      (known.length ? ' (it publishes ' + known.join(', ') + ' nm)' : '') +
      ' - refusing to assume a fibre loss');
  }
  return value;
}

function splitterLoss(part) {
  const split = isNum(part.splitLossDb) ? part.splitLossDb : round(10 * Math.log10(part.ratio), 2);
  const excess = isNum(part.excessLossDb) ? part.excessLossDb : 0;
  return round(split + excess, 3);
}

function lossPart(registry, kind, model, fallbackModel) {
  const chosen = model || (registry.has(kind, fallbackModel) ? fallbackModel : null);
  if (!chosen) {
    const known = registry.all(kind).map(function (p) { return p.model; });
    throw new Error('a ' + kind + ' model is required' + (known.length ? ' - known: ' + known.join(', ') : ''));
  }
  return registry.get(kind, chosen);
}

/**
 * A value as it arrived, for a refusal sentence: JSON where JSON can say it, `String` otherwise.
 *
 * `JSON.stringify(NaN)` is `"null"` and the value is only ever shown after a number check has failed,
 * so the text is the caller's own body rather than a re-description of it.
 */
function showValue(value) {
  // `JSON.stringify(NaN)` is `"null"`, and NaN reaches `wholeCount` as "not a number" - the sentence
  // must say NaN rather than null, so a non-finite number is printed as itself.
  if (typeof value === 'number' && !isFinite(value)) return String(value);
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/**
 * A count of lossy plant, read strictly instead of as zero.
 *
 * `splices: -3`, `connectors: "6"` and `connectors: { count: -6 }` all used to reach
 * `isNum(x) && x > 0`, fail it, and be read as *no* splices or connectors: a key the engine reads,
 * with a value it silently deleted from the ODN loss. Measured on this engine with a GPON B+ design of
 * 22.7 km of G.652.D at 1:64, 10 splices and 6 connectors (ODN 28.294 dB, 0.29 dB over the 28 dB
 * class, verdict `fail`): `connectors: -6`, `connectors: "6"` and `connectors: { count: -6 }` each
 * answered `ok` at ODN 26.494 dB, because 1.80 dB of plant disappeared from a plan the caller asked
 * for it in.
 *
 * Refused rather than defaulted, the same call `assertNumberField` makes for a negative `marginDb`
 * (#146): the request is what is wrong, and every one of these readings moves the answer in the
 * optimistic direction. An *absent* field is still zero plant - that is a documented default, and the
 * result's own totals say so - a present value the budget cannot read is not.
 */
function wholeCount(value, field) {
  if (value === undefined) return 0;
  if (!isNum(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(field + ' must be a whole number at or above 0 and got ' + showValue(value) +
      ' - a count the budget cannot read is refused rather than read as zero, which would delete the ' +
      'loss it names from the ODN');
  }
  return value;
}

/** The connector count, in either documented form: a number, or `{ model, count }`. */
function connectorCountOf(input) {
  if (input === undefined) return 0;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    if (input.count === undefined) {
      throw new TypeError('design.connectors names a model without a count and got ' + showValue(input) +
        ' - a connector model on its own is no connectors, so give { model, count }');
    }
    return wholeCount(input.count, 'design.connectors.count');
  }
  return wholeCount(input, 'design.connectors');
}

/**
 * A design's list of plant - its spans, its splitters - or a refusal naming the value it got.
 *
 * `design.spans || []` read a present-but-unusable list as an empty one: `null`, `0`, `false` and
 * `''` are all falsy, so they became "no cable" and the ODN loss the verdict is computed on came out
 * lower than the plant the caller named. Measured on the baseline design in
 * `test/budget-odn-counts.test.js` with `spans: null`: 0 m of fibre, ODN 23.3 dB and `verdict: ok`,
 * where the plant it names is `fail` - 0.294 dB outside the GPON B+ class budget. A verdict computed
 * on a cable that was dropped is worse than a refusal. `{}` and `"x"` were already refused; every
 * present value is refused the same way now, and an absent key stays the empty plant it describes.
 */
function listField(design, name, what) {
  const value = design[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('design.' + name + ' must be an array of ' + what + 's and got ' +
      showValue(value) + ' - a list the budget cannot read is refused rather than read as no ' + what +
      ', which would delete the loss it names from the ODN');
  }
  return value;
}

/**
 * A splice entry's own `lossDb`, when it states one instead of taking the model's rated loss.
 *
 * `lossDb: -5` used to be used as-is, so a splice list could *gain* 5 dB, and `lossDb: "0.1"` fell back
 * to the model default without a word - two ways for the number the caller wrote not to be the number
 * in the plan.
 */
function spliceEntryLossDb(value, where) {
  if (!isNum(value) || value < 0) {
    throw new TypeError(where + ' must be a non-negative number of dB and got ' + showValue(value) +
      ' - a splice entry states its loss where it is not the model default, and a value the budget ' +
      'cannot read would silently become that default');
  }
  return value;
}

/**
 * The passive side of any link: fibre, splices, connectors, splitters.
 *
 * Shared so the PON path and the active path charge exactly the same losses for the same plant.
 * Returns the individual sums as well as the total, because a report that cannot show its parts is
 * not reviewable.
 */
function computeOdn(design, wavelength, registry) {
  const breakdown = [];

  // --- fibre ---------------------------------------------------------------------
  const spans = listField(design, 'spans', 'span');
  let fibreDb = 0;
  let fibreLengthM = 0;
  spans.forEach(function (span, i) {
    if (!span || !span.cable) throw new TypeError('design.spans[' + i + '].cable is required');
    if (!isNum(span.lengthM) || span.lengthM < 0) throw new TypeError('design.spans[' + i + '].lengthM must be a non-negative number');
    const cable = registry.get('cable', span.cable);
    const dbPerKm = cableAttenuation(cable, wavelength);
    const db = dbPerKm * (span.lengthM / 1000);
    fibreDb += db;
    fibreLengthM += span.lengthM;
    breakdown.push({
      kind: 'fibre',
      label: cable.model + ' ' + Math.round(span.lengthM) + ' m @ ' + wavelength + ' nm (' + dbPerKm + ' dB/km)',
      db: round(db, 3)
    });
  });

  // --- splices -------------------------------------------------------------------
  // Both forms are read strictly: a count the budget cannot use is refused by name (`wholeCount`),
  // never rounded, floored or dropped to zero.
  let spliceLossDb = 0;
  const spliceInput = design.splices === undefined ? 0 : design.splices;
  if (Array.isArray(spliceInput)) {
    spliceInput.forEach(function (s, i) {
      const where = 'design.splices[' + i + ']';
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new TypeError(where + ' must be an object naming a splice model or its loss, and got ' + showValue(s));
      }
      const model = s.model || DEFAULT_SPLICE_MODEL;
      const part = s.lossDb === undefined ? lossPart(registry, 'splice', model, DEFAULT_SPLICE_MODEL) : null;
      const db = part ? part.lossDb : spliceEntryLossDb(s.lossDb, where + '.lossDb');
      spliceLossDb += db;
      breakdown.push({ kind: 'splice', label: 'splice ' + (i + 1) + ' (' + model + ')', db: round(db, 3) });
    });
  } else {
    const spliceCount = wholeCount(spliceInput, 'design.splices');
    if (spliceCount > 0) {
      const part = lossPart(registry, 'splice', design.spliceModel, DEFAULT_SPLICE_MODEL);
      spliceLossDb = part.lossDb * spliceCount;
      breakdown.push({ kind: 'splice', label: spliceCount + ' x ' + part.model + ' splice', db: round(spliceLossDb, 3) });
    }
  }

  // --- connectors ----------------------------------------------------------------
  let connectorLossDb = 0;
  const connectorInput = design.connectors === undefined ? 0 : design.connectors;
  const connectorSpec = connectorInput !== null && typeof connectorInput === 'object' && !Array.isArray(connectorInput)
    ? connectorInput
    : null;
  const connectorModel = (connectorSpec && connectorSpec.model) || design.connectorModel || DEFAULT_CONNECTOR_MODEL;
  const connectorCount = connectorCountOf(connectorInput);
  if (connectorCount > 0) {
    const part = lossPart(registry, 'connector', connectorModel, DEFAULT_CONNECTOR_MODEL);
    connectorLossDb = part.lossDb * connectorCount;
    breakdown.push({ kind: 'connector', label: connectorCount + ' x ' + part.model + ' connector', db: round(connectorLossDb, 3) });
  }

  // --- splitters -----------------------------------------------------------------
  let splitterLossDb = 0;
  let cascadeRatio = 1;
  const splitters = listField(design, 'splitters', 'splitter');
  splitters.forEach(function (s, i) {
    if (!s || !s.model) throw new TypeError('design.splitters[' + i + '].model is required');
    const part = registry.get('splitter', s.model);
    const db = splitterLoss(part);
    splitterLossDb += db;
    cascadeRatio *= part.ratio;
    breakdown.push({ kind: 'splitter', label: 'splitter ' + (i + 1) + ' 1:' + part.ratio + ' ' + part.model, db: round(db, 3) });
  });

  // --- third-party (leased) segments ---------------------------------------------
  // A leased span is real fibre with a stated length and a stated loss, owned by somebody else. It is
  // charged to the budget and counted in the path length, and it is not a cable span: nobody buys
  // cable for a duct they rent. Every field is required - an unknown loss is refused, never zero.
  let thirdPartyLossDb = 0;
  let thirdPartyLengthM = 0;
  const thirdPartyInput = design.thirdParty === undefined ? [] : design.thirdParty;
  if (!Array.isArray(thirdPartyInput)) throw new TypeError('design.thirdParty must be an array of leased segments');
  thirdPartyInput.forEach(function (segment, i) {
    const where = 'design.thirdParty[' + i + ']';
    if (!segment || typeof segment !== 'object') throw new TypeError(where + ' must be an object');
    // Before the values are read: a key this engine cannot read is the cause, and "lengthM must be a
    // non-negative number" is only the symptom of one the caller never spelled. A caller's own
    // bookkeeping key still passes - only a near miss of a field the segment is read through is a
    // refusal.
    designFields.assertKnownFields(segment, THIRD_PARTY_FIELDS, 'the leased segment ' + where, {
      noun: 'field',
      consequence: 'A key the budget does not read is not a setting: a misspelt length or loss is a ' +
        'segment it cannot read, so the lease is missing from the path it was written on.'
    });
    // A budget is one ODN path, so there are no legs here to scope and `leg`/`legs` are refused with
    // the reason instead of being answered as if absent - the caller who sent one believes the lease
    // is on a single leg, and on this surface the whole path pays for it.
    if (segment.leg !== undefined || segment.legs !== undefined) {
      const key = segment.leg !== undefined ? 'leg' : 'legs';
      throw new TypeError(where + ' carries "' + key + '" - a budget is one ODN path, not a circuit ' +
        'with legs, so a leased segment is charged to the whole path and a leg scope cannot be read. ' +
        'Drop the key; the link design is where a segment is scoped to a leg.');
    }
    if (!segment.provider) throw new TypeError(where + '.provider is required - a leased segment names who owns it');
    if (!isNum(segment.lengthM) || segment.lengthM < 0) {
      throw new TypeError(where + '.lengthM must be a non-negative number (the stated length of the leased segment)');
    }
    if (!isNum(segment.lossDb) || segment.lossDb < 0) {
      throw new TypeError(where + '.lossDb must be a non-negative number - a leased segment states its loss, it is never assumed to be zero');
    }
    thirdPartyLossDb += segment.lossDb;
    thirdPartyLengthM += segment.lengthM;
    breakdown.push({
      kind: 'third-party',
      label: 'leased ' + segment.provider + ' ' + Math.round(segment.lengthM) + ' m (' + segment.lossDb + ' dB)',
      db: round(segment.lossDb, 3)
    });
  });

  return {
    fibreDb: fibreDb,
    fibreLengthM: fibreLengthM,
    spliceLossDb: spliceLossDb,
    connectorLossDb: connectorLossDb,
    splitterLossDb: splitterLossDb,
    thirdPartyLossDb: round(thirdPartyLossDb, 3),
    thirdPartyLengthM: round(thirdPartyLengthM, 2),
    cascadeRatio: cascadeRatio,
    breakdown: breakdown,
    warnings: [],
    spanCount: spans.length
  };
}

function verdictFor(headroomDb, marginDb, classHeadroomDb, reasons) {
  if (reasons.length) return 'fail';
  if (headroomDb < marginDb + 2 || classHeadroomDb < 1) return 'marginal';
  return 'ok';
}

/**
 * Why a budget is `marginal`, in the engine's own words.
 *
 * `marginal` is a verdict this engine invented because a design inside 2 dB of its margin - or with
 * under 1 dB of class budget left - is not a clean sign-off, it is a decision somebody has to make
 * (`docs/SPEC.md` §4, `test/budget-optics.test.js`). But the verdict carried no sentence: `reasons` is
 * empty by definition (a reason means `fail`) and `warnings` is the launch-window list, so every caller
 * that wanted to say *why* rebuilt the same subtraction by hand - the printed plan (#138) built one,
 * and the auto-design report built none at all and called the candidate clean.
 *
 * The clause names the figure that is tight, and only that figure:
 *
 *   headroom-tight  headroom 4.56 dB is only 1.56 dB above the 3 dB design margin (sensitivity -30 dBm)
 *   class-tight     only 0.62 dB of the GPON B+ budget of 28 dB is left
 *
 * Both when both are tight. `null` for `ok` and for `fail`: a failing budget has `reasons`, which name
 * the fault and the fix, and a healthy one has nothing to explain. A marginal verdict that reached here
 * with neither figure tight would mean `verdictFor` and this function disagree, so it says the general
 * case rather than going silent.
 *
 * figures: { headroomDb, marginDb, classHeadroomDb, sensitivityDbm, budgetLabel }
 */
function marginalReasonFor(figures) {
  const clauses = [];
  // `headroomDb - marginDb` is the slack the marginal band is measured in; rounding to 2 places so the
  // sentence prints the number the same way the rest of the budget does.
  const slackDb = round(figures.headroomDb - figures.marginDb, 2);
  if (slackDb < 2) {
    clauses.push('headroom ' + figures.headroomDb + ' dB is only ' + slackDb + ' dB above the ' +
      figures.marginDb + ' dB design margin (sensitivity ' + figures.sensitivityDbm + ' dBm)');
  }
  if (figures.classHeadroomDb < 1) {
    clauses.push('only ' + figures.classHeadroomDb + ' dB of the ' + figures.budgetLabel + ' is left');
  }
  if (!clauses.length) {
    return 'the design passes with under 2 dB above the ' + figures.marginDb +
      ' dB margin or under 1 dB of its budget left - a decision to make, not a clean sign-off';
  }
  return clauses.join(', and ');
}

/**
 * The three numbers a pad is bought on, from the power the receiver sees at its strongest launch.
 *
 * Overload is the one failure more power cannot fix: a long-reach optic on a short duct run receives
 * more than its own receiver tolerates, and the remedy is an inline attenuator. Naming the fault
 * without naming the fix leaves the planner to work the pad out by hand, which is the subtract-and-
 * buy arithmetic the engine exists to do. Three numbers and a verdict, because each answers a
 * different question:
 *
 *   overDb    how far the receiver is above its overload point - the loss that has to be added
 *   padDb     the smallest whole-dB pad that gets there (pads are sold in 1 dB steps, so 1.05 dB of
 *             overload needs a 2 dB pad, and a pad is never a fractional thing you can buy)
 *   maxPadDb  the most pad that still leaves `marginDb` of headroom and the class budget intact -
 *             a pad is ODN loss, so it spends the same budget the route spends
 *
 * `fits` is false when the design is contradictory: too loud *and* too tight, so no pad satisfies both
 * and the answer is a shorter reach optic or a different split, not a number.
 *
 * **The pad is sized for the strongest launch, not the weakest.** A pad is fitted once and the optic
 * that lands in the chassis can sit anywhere in its own `txPowerDbmMin..txPowerDbmMax` window - a
 * C+ OLT line card may paint +3 or +7 dBm, and the head-end optic a -4.7 or a +4. A pad computed from
 * the minimum launch is therefore sized for the one case that cannot hurt the receiver, and leaves it
 * above its overload point whenever the module runs hot: 4 dB short on every OLT in the catalogue,
 * whose launch windows are 3-4 dB wide. The number a crew buys must cover the worst case, so `overDb`
 * and `padDb` are taken at `rxPowerMaxDbm` (the receiver's power at the transmitter's maximum launch,
 * or at a requested `txDbm` when one is given) and `atTxDbm` says which launch the pad is sized for.
 */
function padSizing(rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb) {
  const overDb = round(rxPowerMaxDbm - rxSpec.overload, 2);
  const padDb = Math.ceil(overDb);
  // Floor as well as min: the pad itself is a whole number of dB, so a 14.6 dB allowance funds 14 dB.
  // The margin bound is the headroom at the *minimum* launch - the tight side - so a pad that clears
  // it leaves the margin intact at every launch.
  const maxPadDb = Math.floor(round(Math.min(classHeadroomDb, headroomDb - marginDb), 2));
  return {
    overDb: overDb,
    padDb: padDb,
    maxPadDb: maxPadDb,
    atTxDbm: round(txDbmMax, 2),
    fits: maxPadDb >= padDb
  };
}

/**
 * The pad a too-loud link has to carry, or null.
 *
 * Returns null when the receiver is at or below its overload point at the minimum launch - a healthy
 * link needs no pad, and reporting "0 dB" would be a plate somebody orders.
 *
 * Which end is *too loud* is still judged at the minimum launch: that is the worst-case loss budget
 * the class verdict is built on, and a link that is inside its overload point there can always be
 * brought to full launch by the pad this returns. A link that is inside the point there and over it
 * at the ceiling gets no pad from here and a warning instead - see `launchWindowWarning`.
 */
function attenuatorFor(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb) {
  if (!(rxPowerDbm > rxSpec.overload)) return null;
  return padSizing(rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
}

/**
 * The pad a hot module needs: the other half of the launch-window story.
 *
 * Overload is judged at the floor of the transmitter's window, because that is the worst-case loss
 * budget the class verdict is built on - but a design can be inside its overload point there and over
 * it at the ceiling. Every OLT in the catalogue has a 3-4 dB window, so for a C+ line card (+3..+7 dBm)
 * an ODN between about 11 and 15 dB is clean with a weak module and overdrives the ONT with a hot one,
 * and that is an ordinary 1:8 estate with a short feeder. Whether such a design should *fail* is a
 * product decision (#111): failing every one of them would leave auto-design no feasible candidate for
 * a small estate, so the verdict stays where `docs/SPEC.md` §4 puts it. What must not happen is the
 * band passing in silence - a plan signed off on a link that only works with a cold optic.
 *
 * This is the structured form, so a caller can count the band or size its pad without reading prose:
 * the same `{ overDb, padDb, maxPadDb, atTxDbm, fits }` object `attenuator` carries, sized for the top
 * of the launch window. It and `attenuator` are mutually exclusive - one says the receiver is too loud
 * at the floor launch, the other says it is only too loud once the module runs hot. `design.js` counts
 * these to report a synthesised plan whose ONTs all sit in the band.
 *
 * Returns null when the floor launch is already too loud (`attenuatorFor` owns that, and its reason
 * already names the pad) or when the ceiling launch is still inside the overload point.
 */
function launchWindowPad(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb) {
  if (rxPowerDbm > rxSpec.overload) return null;
  if (!(rxPowerMaxDbm > rxSpec.overload)) return null;
  return padSizing(rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
}

/**
 * The launch blind zone, said out loud: one sentence built from the pad `launchWindowPad` returned.
 *
 * `txDbm` is the launch the receiver is clean at and `txSpec` names the transmitter it belongs to, so
 * the sentence reads as a band of the window rather than a second fault.
 */
function launchWindowWarning(pad, rxPowerDbm, txDbm, txSpec, rxSpec, marginDb) {
  if (!pad) return null;
  return 'the ' + rxSpec.who + ' is inside its overload point only at the bottom of the ' + txSpec.who +
    ' launch window: ' + rxPowerDbm + ' dBm at ' + round(txDbm, 2) + ' dBm, but ' + pad.overDb +
    ' dB above ' + rxSpec.overload + ' dBm at the ' + pad.atTxDbm + ' dBm top of the window - ' +
    (pad.fits
      ? 'fit a ' + pad.padDb + ' dB inline pad (up to ' + pad.maxPadDb + ' dB still passes the ' + marginDb +
        ' dB margin and the class budget)'
      : 'and no whole-dB pad clears it without breaking the ' + marginDb +
        ' dB margin or the class budget, so this needs a different split or optic');
}

/**
 * A launch power inside an end object is refused, because the launch is a design field.
 *
 * Both doc blocks used to advertise the ends as `{ model, txDbm? }` from 0.1.0 until this guard, and
 * `opticalBudget`/`pointToPoint` have only ever read `design.txDbm`. A caller who followed the shape
 * got the launch silently reset to the transmitter's minimum: on the 15 km GPON B+ design in
 * `test/budget-design-fields.test.js` that is -13.30 dBm instead of -9.80 dBm - 3.50 dB optimistic,
 * with the headroom, the overload check and the pad all sized for a module running cold.
 * `assertKnownFields` cannot catch it: it guards the design's top level, and the typo is one object
 * down, so the refusal has to live where the end is read.
 *
 * Only `txDbm` is refused, because it is the one knob the shape ever advertised. An end object may
 * carry whatever else a caller likes - pass the whole catalogue entry, vendor and ports and all - and
 * the budget still reads `model` and nothing else from it: a guard that refused every unknown key
 * would refuse a part object, which is a shape the API hands straight through.
 */
function refuseEndpointLaunch(end, path) {
  if (!end || typeof end !== 'object' || end.txDbm === undefined) return;
  throw new TypeError(path + '.txDbm is not a field the budget reads and got ' + showValue(end.txDbm) +
    ' - the launch power is the design field "txDbm", beside the end and not inside it: {"' +
    path.split('.')[1] + '":{"model":"..."},"txDbm":5}');
}

/**
 * The rows of one direction, summarised: which ONTs are in the band, the worst by overshoot, and the
 * sizes an order needs. `direction` comes from the budget result the row carries - `allOntBudgets`
 * stamps every one - and rows a caller built by hand default to downstream, which is the direction
 * every caller passed before the reverse pass existed.
 *
 * Split out of `launchWindowNote` because the note is now a sentence about *two* passes over one ODN:
 * it has to compare the downstream band with the upstream one and quote the larger pad, and two
 * copies of the count-and-size arithmetic would disagree the first time one of them changed.
 */
function bandSummary(rows) {
  const budgeted = (rows || []).filter(function (r) { return r && r.result; });
  const hot = budgeted.filter(function (r) { return r.result.launchWindowPad; });
  const direction = budgeted.length && budgeted[0].result.direction === 'up' ? 'up' : 'down';
  // Pads are bought in whole dB, so the sizes are what an order needs: a 1:16 estate can need a 1 dB
  // pad on six drops and a 2 dB pad on two, and quoting the worst size for all eight over-pads the six.
  const bySize = new Map();
  hot.forEach(function (r) {
    const db = r.result.launchWindowPad.padDb;
    bySize.set(db, (bySize.get(db) || 0) + 1);
  });
  const sizes = Array.from(bySize.keys()).sort(function (a, b) { return b - a; });
  const sizeList = sizes.map(function (db) { return bySize.get(db) + ' x ' + db + ' dB'; }).join(', ');
  if (!hot.length) {
    return { direction: direction, budgeted: budgeted, hot: hot, worst: null, pad: null,
      sizes: sizes, sizeList: sizeList, noPad: 0, rest: budgeted.length, bySize: bySize };
  }
  // The worst overshoot, ties broken on the ONT id: the sentence must not depend on the order the
  // plant happened to be built in, and `reduce` keeps whichever row came first.
  const worst = hot.reduce(function (a, b) {
    const diff = b.result.launchWindowPad.overDb - a.result.launchWindowPad.overDb;
    if (diff > 0) return b;
    if (diff < 0) return a;
    return String(b.ont) < String(a.ont) ? b : a;
  });
  const noPad = hot.filter(function (r) { return !r.result.launchWindowPad.fits; }).length;
  return { direction: direction, budgeted: budgeted, hot: hot, worst: worst,
    pad: worst.result.launchWindowPad, sizes: sizes, sizeList: sizeList, noPad: noPad,
    rest: budgeted.length - hot.length, bySize: bySize };
}

/**
 * How the band is named in one direction. Downstream the OLT launches into the ONT, so the receiver
 * is the ONT and the window is the OLT's; upstream it is the other way round, and quoting the OLT's
 * window for a figure measured at the ONT's launch is how a report stops describing the plant in front
 * of the crew. An active plant has no OLT: its two ends are a head-end and a customer optic.
 */
function bandVoice(result, direction) {
  const p2p = result.technology === 'p2p';
  const up = direction === 'up';
  const windowModel = up
    ? (p2p ? result.cpe : result.ont)
    : (p2p ? result.headEnd : result.olt);
  return {
    // Downstream reads as before: 'inside the overload point only at the bottom of the OLT X launch
    // window' - the ONT is the implied receiver of a PON, and naming it too would change every plan
    // quote without adding a fact.
    receiver: up ? (p2p ? 'the head-end optic' : 'the OLT receiver') : (p2p ? 'the customer optic' : null),
    window: (up ? (p2p ? 'customer optic ' : 'ONT ') : (p2p ? 'head-end optic ' : 'OLT ')) + windowModel,
    stale: up
      ? (p2p ? 'every customer optic launches at ' : 'every ONT laser launches at ')
      : 'every line card lands at '
  };
}

/** The band as one sentence, for one direction's summary. */
function bandSentence(sum, marginDb) {
  const worst = sum.worst;
  const pad = sum.pad;
  const voice = bandVoice(worst.result, sum.direction);
  const hot = sum.hot.length;
  const total = sum.budgeted.length;
  // One pad at the OLT is only the right purchase when every ONT in the band needs the same pad. A
  // pad is one size, so a band that needs a 1 dB pad on six drops and a 2 dB pad on two cannot be
  // served from the feeder: the 2 dB pad over-pads the six and spends their margin to fix the two.
  const where = sum.rest === 0 && sum.bySize.size === 1
    ? pad.padDb + ' dB of inline pad at the OLT carries the design to full launch'
    : 'a pad at each of the ' + hot + ' affected ONT' + (hot === 1 ? '' : 's') +
      ' carries the design to full launch (' + sum.sizeList + ')' +
      (sum.rest === 0
        ? ', because one pad size does not serve the whole band'
        : ', and the other ' + sum.rest + ' cannot share a pad on the feeder');

  return hot + ' of ' + total + ' ONT' + (total === 1 ? '' : 's') + ' ' + (hot === 1 ? 'is' : 'are') +
    ' inside ' + (voice.receiver ? voice.receiver + "'s overload point" : 'the overload point') +
    ' only at the bottom of the ' + voice.window + ' launch window: worst ' + pad.overDb +
    ' dB over at the ' + pad.atTxDbm + ' dBm top, ' +
    (pad.fits
      ? 'so ' + where
      : 'and the worst of them needs ' + pad.padDb + ' dB of pad against the ' + pad.maxPadDb +
        ' dB the margin and the class budget can fund') +
    ' - as it stands it holds only while ' + voice.stale + worst.result.txDbm + ' dBm' +
    (sum.noPad ? '; ' + sum.noPad + ' of them cannot be padded inside the ' + marginDb +
      ' dB margin and the class budget, so those need a different split or optic' : '');
}

/**
 * The launch-window band, said once for the whole plant rather than once per ONT.
 *
 * `launchWindowWarning` is a per-ONT sentence, because a budget describes one link. A plant is not a
 * link: a 1:16 splitter with short drops puts every ONT in the band at once, and a report that repeats
 * one sentence sixteen times buries the number the report exists for - how much of the estate is in
 * the band, and how much pad to buy. This is that sentence, built from the rows `allOntBudgets`
 * returned, so the design report and the printed plan quote one implementation instead of two
 * (`engine/design.js` used to carry its own copy).
 *
 * Where the pad goes is the part a purchase order gets wrong:
 *
 * - **Every ONT in the band**: one pad at the OLT holds the whole plant, because there is no receiver
 *   below it that a pad would push under its margin.
 * - **Some of them**: the pad belongs at each affected ONT. A pad on the shared feeder is one pad
 *   doing the same 1-4 dB to the ONTs that were fine, spending their margin to fix somebody else's
 *   overload, so the note names the ONTs it does not cover and never says "at the OLT".
 *
 * The verdict does not move (#111): the band is a warning on an `ok` budget, and only the
 * `pad.fits === false` clause - a pad the margin and the class budget cannot fund - points at a
 * different split or optic.
 *
 * **Both directions of one ODN.** `opts.other` is the reverse pass's rows, and it changes the size,
 * not the verdict: a pad is ODN loss, so one pad serves both receivers and the note must name the
 * largest either direction needs. The direction that binds leads the sentence - upstream reads "the
 * OLT receiver is inside its overload point only at the bottom of the ONT's launch window" - and the
 * milder direction is named beside it when the two sizes differ. Without that, a C+ 1:8 estate 3 km
 * out is told to fit the 3 dB pad its downstream band asks for and the OLT receiver is 1.45 dB over
 * its overload point at the top of the ONT's window, with every row `ok` and no other sentence on the
 * page about it.
 *
 * rows are `{ ont, name, result }` as `network.allOntBudgets` returns them; rows whose budget threw
 * carry no result and are not counted, because "2 of 3" has to mean three budgeted ONTs. Returns null
 * when no row in either pass is in the band - an empty note is not a warning, and a 0 dB pad is a
 * plate nobody orders.
 */
function launchWindowNote(rows, opts) {
  const o = opts || {};
  const marginDb = isNum(o.marginDb) ? o.marginDb : DEFAULT_MARGIN_DB;
  const mine = bandSummary(rows);
  const theirs = o.other ? bandSummary(o.other) : null;
  const theirsHot = !!(theirs && theirs.hot.length);
  if (!mine.hot.length && !theirsHot) return null;

  // A pad is ODN loss, so one pad in the ODN serves both receivers - and the size to buy is the
  // largest either direction needs. Sizing it from the downstream band alone leaves the OLT receiver
  // over its overload point whenever the ONT runs at the top of its window (#233): on a C+ 1:8 estate
  // 3 km out the downstream band asks for 3 dB and the upstream band for 5 dB, and both rows are `ok`.
  // The direction that binds leads the sentence, because its figure is the one an order has to match;
  // the reverse band, when it needs less, is named beside it rather than left to be discovered.
  let primary = mine;
  let other = theirs;
  if (!mine.hot.length) { primary = theirs; other = mine; }
  else if (theirsHot && theirs.pad.padDb > mine.pad.padDb) { primary = theirs; other = mine; }

  let text = bandSentence(primary, marginDb);
  if (other && other.hot.length && other.pad.padDb !== primary.pad.padDb) {
    // The other direction's own sizes, said only when they differ: an equal size is one purchase and
    // one sentence. It cannot promise a single pad, because the advice above may already be a pad at
    // each ONT - what holds in both cases is that a pad is ODN loss and serves both receivers.
    text += '; the ' + (other.direction === 'up' ? 'upstream' : 'downstream') + ' direction needs ' +
      other.sizeList + ', and a pad is ODN loss in both directions, so size it for the larger';
  }

  return {
    text: text,
    onts: primary.hot.length,
    total: primary.budgeted.length,
    worstOnt: primary.worst.ont,
    olt: primary.worst.result.olt,
    direction: primary.direction,
    padDb: primary.pad.padDb,
    overDb: primary.pad.overDb,
    atTxDbm: primary.pad.atTxDbm,
    maxPadDb: primary.pad.maxPadDb,
    sizes: primary.sizes,
    fits: primary.pad.fits,
    unpadded: primary.noPad
  };
}

/**
 * The upstream half of every link over this ODN, said once for the plant.
 *
 * A PON is two links over one loss: the OLT launches into the ONT at 1490 nm and the ONT launches into
 * the OLT at 1310 nm, which is the more lossy wavelength. `opticalBudget` answers either direction -
 * `direction: 'up'` reads the OLT's own receiver - but every surface that summarised a *plant* asked
 * for the default one, so a design that is `ok` on every ONT downstream and `fail` upstream was
 * reported as clean (#185). This is the sentence that stops that, built from the rows
 * `allOntBudgets(..., { direction: 'up' })` returned so the design report and any other consumer
 * quote one implementation instead of two - the same contract as `launchWindowNote`.
 *
 * What it deliberately does **not** do is move a verdict. An upstream failure is reported, not made
 * infeasible: no PON class floor is modelled (only the ceiling, `CLASS_BUDGET_DB`), so gating on the
 * upstream direction would empty auto-design for an ordinary short-feed estate - the open decision in
 * #185 and #111. The note says so in as many words, because a reader who sees one direction fail and
 * a `feasible: true` beside it deserves the reason rather than a contradiction.
 *
 * `rows` are `{ ont, name, result }` as `allOntBudgets` returns them, and a row whose budget threw is
 * not counted: "1 of 3" has to mean three budgeted ONTs. Returns null when nothing fails upstream, so
 * a clean plant carries no sentence at all - the printed plan's own rule for a warning.
 *
 * The worst row is the one furthest past its verdict, not the one with the least headroom: an overload
 * failure has plenty of headroom and still fails, so the figure compared is the largest of the three
 * ways a budget fails - dB over the overload point, dB short of the margin, dB over the budget.
 */
function upstreamNote(rows, opts) {
  const o = opts || {};
  const marginDb = isNum(o.marginDb) ? o.marginDb : DEFAULT_MARGIN_DB;
  const budgeted = (rows || []).filter(function (r) { return r && r.result; });
  const failing = budgeted.filter(function (r) { return r.result.verdict === 'fail'; });
  if (!failing.length) return null;

  // How far past the verdict a row is, in dB, so overload, headroom and budget failures compare on
  // one number. A row that fails none of them (a route longer than the optic reaches) scores 0 and is
  // still nameable when it is the only failure.
  function shortfallDb(row) {
    const r = row.result;
    const over = isNum(r.rxPowerDbm) && isNum(r.overloadDbm) ? r.rxPowerDbm - r.overloadDbm : -Infinity;
    const tight = isNum(r.headroomDb) ? marginDb - r.headroomDb : -Infinity;
    const overBudget = isNum(r.classHeadroomDb) ? -r.classHeadroomDb : -Infinity;
    const worst = Math.max(over, tight, overBudget);
    return worst === -Infinity ? 0 : worst;
  }

  // Ties break on the ONT id, so the sentence never depends on the order the plant was built in.
  const worst = failing.reduce(function (a, b) {
    const diff = shortfallDb(b) - shortfallDb(a);
    if (diff > 0) return b;
    if (diff < 0) return a;
    return String(b.ont) < String(a.ont) ? b : a;
  });
  const pad = worst.result.attenuator;
  const others = failing.length - 1;
  const reason = worst.result.reasons[0] || 'the budget fails with no reason recorded';

  const text = failing.length + ' of ' + budgeted.length + ' ONT' + (budgeted.length === 1 ? '' : 's') +
    ' ' + (failing.length === 1 ? 'fails' : 'fail') + ' upstream over the same ODN - ' +
    (worst.name || worst.ont) + ': ' + reason +
    // A second parenthetical reads as a footnote to the fix; a semicolon keeps the counts in one
    // breath, which is what a report of 'how much of the estate is failing' is.
    (others > 0 ? '; ' + others + ' more ONT' + (others === 1 ? '' : 's') + ' fail upstream' : '') +
    // The reason above is a clause, not a sentence: it has no full stop of its own, and the parenthetical
    // is where one used to go missing when a plant had more than one failing ONT.
    '.' +
    // One pad is ODN loss in both directions, and the upstream overload is the loud side: the band
    // note offers the pad that clears the ONT receiver, which is the smaller of the two numbers.
    (pad ? ' A pad is ODN loss and serves both directions, so ' + pad.padDb +
      ' dB is the size to buy - a pad sized for the launch band alone leaves the other receiver over its limit.' : '') +
    ' The design is still ranked and offered on its downstream verdict: an upstream failure is ' +
    'reported here rather than treated as infeasibility, because the plant is only ever judged ' +
    'against a ceiling on ODN loss.';

  return {
    text: text,
    onts: failing.length,
    total: budgeted.length,
    worstOnt: worst.ont,
    // Named the way the technology names it: an active plant has no OLT to blame.
    receiver: worst.result.technology === 'p2p'
      ? 'head-end optic ' + worst.result.headEnd
      : 'OLT ' + worst.result.olt,
    rxPowerDbm: isNum(worst.result.rxPowerDbm) ? worst.result.rxPowerDbm : null,
    overloadDbm: isNum(worst.result.overloadDbm) ? worst.result.overloadDbm : null,
    shortfallDb: round(shortfallDb(worst), 2),
    padDb: pad ? pad.padDb : null,
    fits: pad ? pad.fits : null
  };
}

/** The clause an overload reason carries, so the refusal says what to do about it. */
function attenuatorClause(pad, marginDb) {
  if (!pad) return '';
  if (!pad.fits) {
    return '; no inline pad clears the overload point without breaking the ' + marginDb +
      ' dB margin, so this needs a shorter-reach optic or a different split';
  }
  return '; fit a ' + pad.padDb + ' dB inline pad, which holds the receiver inside its overload point ' +
    'even at the ' + pad.atTxDbm + ' dBm top of its launch window (up to ' + pad.maxPadDb +
    ' dB still passes the ' + marginDb + ' dB margin and the class budget)';
}

/**
 * The knobs every budget entry point reads, checked once - by the PON budget, by the active budget,
 * and by `/api/projects/:id/budget` before it budgets a single ONT.
 *
 * They are the same four on every path, and they all move the verdict: a negative `marginDb` or
 * `allowanceDb` is read straight into the headroom test, a `direction` that is not `up` or `down`
 * is answered as `down` - a different receiver at a different wavelength - and `txDbm` is the launch
 * the headroom, the overload check and the pad are all sized for. A value that is present and
 * unusable is refused here rather than dropped, because a dropped reserve is a verdict computed
 * without the loss the caller asked for. Absent is absent: the defaults are documented and echoed in
 * the result.
 *
 * `txDbm` is checked here for the reason #161 added the nested-launch refusal: a launch the caller
 * asked for and the budget cannot read used to fall back to the transmitter's minimum, which is the
 * one case that cannot hurt the receiver, so the answer was optimistic and silent. A launch outside
 * the module's window is *not* refused - it is a real case to budget (a weak laser) and the budget
 * already answers it with a warning naming the range. Only a value that is not a number is a mistake.
 */
function assertDesignKnobs(design, what) {
  designFields.assertChoiceField(design, 'direction', ['up', 'down'], what);
  designFields.assertNumberField(design, 'marginDb', 0, what);
  designFields.assertNumberField(design, 'allowanceDb', 0, what);
  designFields.assertNumberField(design, 'txDbm', Number.NEGATIVE_INFINITY, what, {
    measure: 'a launch power in dBm',
    unusable: "A launch the budget cannot read is refused rather than dropped: falling back to the " +
      "transmitter's minimum answers the one case that cannot hurt the receiver, which is not the " +
      "case the caller asked about."
  });
}

/**
 * Refuse a **project budget** body whose key is a near miss of one the budget reads.
 *
 * The project budget is the one endpoint that takes its knobs off a hand-written body and then hands
 * that body to `network.designForOnt`, which reads eight named fields. Without this guard a near miss
 * was simply not read: `{"margindb": 40}` answered `200` with `marginDb: 3` echoed, so a link 30 dB
 * short of the reserve the caller asked for was signed off - the same defect `opticalBudget` refuses
 * one endpoint over, and the same narrow rule (case, plural, prefix, one letter wrong); a key that is
 * not a near miss of a field that exists is still ignored.
 */
function assertProjectBudgetFields(body) {
  designFields.assertKnownFields(body, PROJECT_BUDGET_FIELDS, 'the project budget');
}

/**
 * Run a PON budget.
 *
 * `design` (all lengths in metres):
 *   direction    'down' | 'up'                       (default 'down')
 *   wavelength   '1310' | '1490' | '1550'            (default 1490 down / 1310 up)
 *   olt          { model }                           the launch is `txDbm`, below
 *   ont          { model }
 *   spans        [{ cable: model, lengthM }]
 *   splitters    [{ model }]                         (cascade, in order from the OLT)
 *   splices      number | [{ model?, lossDb? }]      (default model: parts/splice/fusion)
 *   connectors   number | { count, model }
 *   allowanceDb  extra design allowance              (default 0)
 *   marginDb     design reserve required             (default 3)
 *   txDbm        launch power to budget at           (default: the transmitter's minimum)
 */
function opticalBudget(design, registry) {
  if (!design || typeof design !== 'object') throw new TypeError('opticalBudget needs a design object');
  if (!registry) throw new TypeError('opticalBudget needs a parts registry');
  designFields.assertKnownFields(design, PON_DESIGN_FIELDS, 'the PON budget');
  assertDesignKnobs(design, 'the PON budget');

  // The pair (wavelength, direction) is checked here rather than left to the caller: a downstream
  // wavelength on an upstream verdict quotes a loss the link never sees.
  assertPonWavelength(design);
  const direction = design.direction === 'up' ? 'up' : 'down';
  const wavelength = design.wavelength === undefined || design.wavelength === null
    ? DEFAULT_WAVELENGTH[direction]
    : String(design.wavelength);

  if (!design.olt || !design.olt.model) throw new TypeError('design.olt.model is required');
  if (!design.ont || !design.ont.model) throw new TypeError('design.ont.model is required');
  const olt = registry.get('olt', design.olt.model);
  const ont = registry.get('ont', design.ont.model);
  refuseEndpointLaunch(design.olt, 'design.olt');
  refuseEndpointLaunch(design.ont, 'design.ont');

  if (olt.pon !== ont.pon) {
    throw new Error('the OLT is ' + olt.pon + ' and the ONT is ' + ont.pon + ' - they cannot share a PON');
  }

  const marginDb = isNum(design.marginDb) ? design.marginDb : DEFAULT_MARGIN_DB;
  const allowanceDb = isNum(design.allowanceDb) ? design.allowanceDb : 0;
  const warnings = [];
  const odn = computeOdn(design, wavelength, registry);
  if (!odn.spanCount) warnings.push('no cable spans: this budget describes an OLT patched straight into an ONT');

  // --- transmit power, worst case ------------------------------------------------
  const txSpec = direction === 'down'
    ? { min: olt.txPowerDbmMin, max: olt.txPowerDbmMax, who: 'OLT ' + olt.model }
    : { min: ont.txPowerDbmMin, max: ont.txPowerDbmMax, who: 'ONT ' + ont.model };
  let txDbm = txSpec.min;
  if (design.txDbm !== undefined) {
    // A value that is not a number was refused by `assertDesignKnobs` above; an out-of-window one is
    // a real design and is answered with a warning, not a refusal.
    if (design.txDbm < txSpec.min || design.txDbm > txSpec.max) {
      warnings.push('requested transmit power ' + design.txDbm + ' dBm is outside the ' + txSpec.who +
        ' range ' + txSpec.min + '..' + txSpec.max + ' dBm');
    }
    txDbm = design.txDbm;
  }

  const odnLossDb = round(odn.fibreDb + odn.spliceLossDb + odn.connectorLossDb + odn.splitterLossDb + odn.thirdPartyLossDb, 3);
  const totalLossDb = round(odnLossDb + allowanceDb, 3);
  const rxPowerDbm = round(txDbm - totalLossDb, 2);

  const rxSpec = direction === 'down'
    ? { sensitivity: ont.rxSensitivityDbm, overload: ont.rxOverloadDbm, who: 'ONT ' + ont.model }
    : { sensitivity: olt.rxSensitivityDbm, overload: olt.rxOverloadDbm, who: 'OLT ' + olt.model };

  // The same loss, at the other end of the transmitter's window: what the receiver sees when the
  // optic that lands in the chassis is a hot one. Only the pad uses this - see `attenuatorFor`.
  const txDbmMax = design.txDbm !== undefined ? txDbm : txSpec.max;
  const rxPowerMaxDbm = round(txDbmMax - totalLossDb, 2);
  const headroomDb = round(rxPowerDbm - rxSpec.sensitivity, 2);
  const budgetDb = olt.budgetDb;
  const classHeadroomDb = round(budgetDb - odnLossDb, 2);

  const reasons = [];
  // A pad is ODN loss, so the same figures that decide headroom decide how much of it fits.
  const attenuator = attenuatorFor(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
  if (attenuator) {
    reasons.push(rxPowerDbm + ' dBm at the ' + rxSpec.who + ' is above its overload point ' + rxSpec.overload + ' dBm - too much power' + attenuatorClause(attenuator, marginDb));
  }
  const launchPad = launchWindowPad(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
  const launchWarning = launchWindowWarning(launchPad, rxPowerDbm, txDbm, txSpec, rxSpec, marginDb);
  if (launchWarning) warnings.push(launchWarning);
  if (headroomDb < marginDb) {
    reasons.push('headroom ' + headroomDb + ' dB is below the ' + marginDb + ' dB design margin (sensitivity ' + rxSpec.sensitivity + ' dBm)');
  }
  if (classHeadroomDb < 0) {
    reasons.push('ODN loss ' + odnLossDb + ' dB exceeds the ' + olt.pon + ' ' + olt.class + ' budget of ' + budgetDb + ' dB');
  }
  if (odn.cascadeRatio > (olt.maxSplitRatio || 128)) {
    reasons.push('splitter cascade is 1:' + odn.cascadeRatio + ', beyond the OLT limit of 1:' + (olt.maxSplitRatio || 128));
  }

  const verdict = verdictFor(headroomDb, marginDb, classHeadroomDb, reasons);
  // A marginal verdict carries the figure it is tight on, so no caller rebuilds the subtraction by
  // hand - see `marginalReasonFor`. `null` for `ok` (nothing to explain) and for `fail` (its `reasons`
  // name the fault and the fix).
  const marginalReason = verdict === 'marginal'
    ? marginalReasonFor({
      headroomDb: headroomDb,
      marginDb: marginDb,
      classHeadroomDb: classHeadroomDb,
      sensitivityDbm: rxSpec.sensitivity,
      budgetLabel: String(olt.pon).toUpperCase() + ' ' + olt.class + ' budget of ' + budgetDb + ' dB'
    })
    : null;

  return {
    ok: verdict !== 'fail',
    verdict: verdict,
    marginalReason: marginalReason,
    technology: 'pon',
    direction: direction,
    wavelength: wavelength,
    pon: olt.pon,
    oltClass: olt.class,
    olt: olt.model,
    ont: ont.model,
    txDbm: round(txDbm, 2),
    rxPowerDbm: rxPowerDbm,
    sensitivityDbm: rxSpec.sensitivity,
    overloadDbm: rxSpec.overload,
    marginDb: marginDb,
    headroomDb: headroomDb,
    budgetDb: budgetDb,
    odnLossDb: odnLossDb,
    totalLossDb: totalLossDb,
    classHeadroomDb: classHeadroomDb,
    attenuator: attenuator,
    launchWindowPad: launchPad,
    cascadeRatio: odn.cascadeRatio,
    fibreLengthM: round(odn.fibreLengthM, 1),
    leasedLengthM: round(odn.thirdPartyLengthM, 1),
    breakdown: odn.breakdown,
    reasons: reasons,
    warnings: warnings
  };
}

/**
 * Run an active (point-to-point) budget between two optics.
 *
 * `design`:
 *   headEnd   { model }                the optic at the aggregation end
 *   cpe       { model }                the optic at the customer end
 *   direction 'down' | 'up'            (default 'down')
 *   wavelength                         (default: the head-end optic's wavelength)
 *   spans, splices, connectors, allowanceDb, marginDb, txDbm   — as for the PON budget
 *
 * The second verdict here is the link's own loss budget, `launch(min) − sensitivity`, rather than a
 * PON class: an active link has no class, it has two datasheets. Reach is checked separately, because
 * a link can be 3 dB inside its budget and still be 60 km down a 10 km optic.
 */
function pointToPoint(design, registry) {
  if (!design || typeof design !== 'object') throw new TypeError('pointToPoint needs a design object');
  if (!registry) throw new TypeError('pointToPoint needs a parts registry');
  designFields.assertKnownFields(design, ACTIVE_DESIGN_FIELDS, 'the active budget');
  assertDesignKnobs(design, 'the active budget');
  if (!design.headEnd || !design.headEnd.model) throw new TypeError('design.headEnd.model is required (the optic at the aggregation end)');
  if (!design.cpe || !design.cpe.model) throw new TypeError('design.cpe.model is required (the optic at the customer end)');

  const headEnd = registry.get('transceiver', design.headEnd.model);
  const cpe = registry.get('transceiver', design.cpe.model);
  refuseEndpointLaunch(design.headEnd, 'design.headEnd');
  refuseEndpointLaunch(design.cpe, 'design.cpe');

  if (headEnd.speedMbps !== cpe.speedMbps) {
    throw new Error('the optics run at different rates (' + headEnd.speedMbps + ' and ' + cpe.speedMbps +
      ' Mb/s) - they cannot form a link');
  }
  if (headEnd.wavelengthNm !== cpe.wavelengthNm) {
    throw new Error('the optics are on different wavelengths (' + headEnd.wavelengthNm + ' and ' +
      cpe.wavelengthNm + ' nm) - they cannot hear each other');
  }
  const wavelength = String(design.wavelength || headEnd.wavelengthNm);
  if (String(headEnd.wavelengthNm) !== wavelength) {
    throw new Error('a ' + headEnd.wavelengthNm + ' nm optic cannot be budgeted at ' + wavelength +
      ' nm - a link is budgeted at the wavelength it transmits on');
  }

  const direction = design.direction === 'up' ? 'up' : 'down';
  const marginDb = isNum(design.marginDb) ? design.marginDb : DEFAULT_MARGIN_DB;
  const allowanceDb = isNum(design.allowanceDb) ? design.allowanceDb : 0;
  const warnings = [];
  const odn = computeOdn(design, wavelength, registry);
  if (!odn.spanCount) warnings.push('no cable spans: this budget describes two optics patched back to back');

  const txSpec = direction === 'down'
    ? { min: headEnd.txPowerDbmMin, max: headEnd.txPowerDbmMax, who: 'head-end optic ' + headEnd.model }
    : { min: cpe.txPowerDbmMin, max: cpe.txPowerDbmMax, who: 'customer optic ' + cpe.model };
  let txDbm = txSpec.min;
  if (design.txDbm !== undefined) {
    // A value that is not a number was refused by `assertDesignKnobs` above; an out-of-window one is
    // a real design and is answered with a warning, not a refusal.
    if (design.txDbm < txSpec.min || design.txDbm > txSpec.max) {
      warnings.push('requested transmit power ' + design.txDbm + ' dBm is outside the ' + txSpec.who +
        ' range ' + txSpec.min + '..' + txSpec.max + ' dBm');
    }
    txDbm = design.txDbm;
  }

  const rxSpec = direction === 'down'
    ? { sensitivity: cpe.rxSensitivityDbm, overload: cpe.rxOverloadDbm, who: 'customer optic ' + cpe.model }
    : { sensitivity: headEnd.rxSensitivityDbm, overload: headEnd.rxOverloadDbm, who: 'head-end optic ' + headEnd.model };

  const odnLossDb = round(odn.fibreDb + odn.spliceLossDb + odn.connectorLossDb + odn.splitterLossDb + odn.thirdPartyLossDb, 3);
  const totalLossDb = round(odnLossDb + allowanceDb, 3);
  const rxPowerDbm = round(txDbm - totalLossDb, 2);
  // Which end launches depends on the direction, so the pair's own budget does too: upstream it is the
  // customer optic's worst-case launch into the head-end receiver. Reading the head-end launch in both
  // directions reported the downstream budget as the upstream figure - a link budgeted inside 9.8 dB
  // while B was actually launching 11.4 dB of headroom, or the reverse for a weak customer laser.
  const budgetDb = direction === 'down'
    ? round(headEnd.txPowerDbmMin - cpe.rxSensitivityDbm, 2)
    : round(cpe.txPowerDbmMin - headEnd.rxSensitivityDbm, 2);
  // What the customer (or head-end) receiver sees when the launching optic is at the top of its
  // window - the power the pad has to cover. Only the pad uses it; see `attenuatorFor`.
  const txDbmMax = design.txDbm !== undefined ? txDbm : txSpec.max;
  const rxPowerMaxDbm = round(txDbmMax - totalLossDb, 2);
  const headroomDb = round(rxPowerDbm - rxSpec.sensitivity, 2);
  const classHeadroomDb = round(budgetDb - odnLossDb, 2);
  const reachM = Math.min(headEnd.reachM, cpe.reachM);

  const reasons = [];
  // A pad is ODN loss, so the same figures that decide headroom decide how much of it fits.
  const attenuator = attenuatorFor(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
  if (attenuator) {
    reasons.push(rxPowerDbm + ' dBm at the ' + rxSpec.who + ' is above its overload point ' + rxSpec.overload + ' dBm - too much power' + attenuatorClause(attenuator, marginDb));
  }
  const launchPad = launchWindowPad(rxPowerDbm, rxPowerMaxDbm, txDbmMax, rxSpec, headroomDb, marginDb, classHeadroomDb);
  const launchWarning = launchWindowWarning(launchPad, rxPowerDbm, txDbm, txSpec, rxSpec, marginDb);
  if (launchWarning) warnings.push(launchWarning);
  if (headroomDb < marginDb) {
    reasons.push('headroom ' + headroomDb + ' dB is below the ' + marginDb + ' dB design margin (sensitivity ' + rxSpec.sensitivity + ' dBm)');
  }
  if (classHeadroomDb < 0) {
    reasons.push('link loss ' + odnLossDb + ' dB exceeds the ' + budgetDb + ' dB this optic pair can afford');
  }
  const pathLengthM = round(odn.fibreLengthM + odn.thirdPartyLengthM, 2);
  if (pathLengthM > reachM) {
    reasons.push('the route is ' + Math.round(pathLengthM) + ' m but the shorter optic reaches ' + reachM + ' m');
  }

  const verdict = verdictFor(headroomDb, marginDb, classHeadroomDb, reasons);
  // Same sentence as the PON path, with the link's own loss budget named instead of a PON class.
  const marginalReason = verdict === 'marginal'
    ? marginalReasonFor({
      headroomDb: headroomDb,
      marginDb: marginDb,
      classHeadroomDb: classHeadroomDb,
      sensitivityDbm: rxSpec.sensitivity,
      budgetLabel: budgetDb + ' dB this optic pair can afford'
    })
    : null;

  return {
    ok: verdict !== 'fail',
    verdict: verdict,
    marginalReason: marginalReason,
    technology: 'p2p',
    direction: direction,
    wavelength: wavelength,
    headEnd: headEnd.model,
    cpe: cpe.model,
    speedMbps: headEnd.speedMbps,
    txDbm: round(txDbm, 2),
    rxPowerDbm: rxPowerDbm,
    sensitivityDbm: rxSpec.sensitivity,
    overloadDbm: rxSpec.overload,
    marginDb: marginDb,
    headroomDb: headroomDb,
    budgetDb: budgetDb,
    odnLossDb: odnLossDb,
    totalLossDb: totalLossDb,
    classHeadroomDb: classHeadroomDb,
    attenuator: attenuator,
    launchWindowPad: launchPad,
    cascadeRatio: 1,
    fibreLengthM: round(odn.fibreLengthM, 1),
    leasedLengthM: round(odn.thirdPartyLengthM, 1),
    pathLengthM: round(pathLengthM, 1),
    thirdPartyLossDb: odn.thirdPartyLossDb,
    reachM: reachM,
    breakdown: odn.breakdown,
    reasons: reasons,
    warnings: warnings
  };
}

module.exports = {
  assertDesignKnobs: assertDesignKnobs,
  assertPonWavelength: assertPonWavelength,
  assertProjectBudgetFields: assertProjectBudgetFields,
  DEFAULT_MARGIN_DB: DEFAULT_MARGIN_DB,
  DEFAULT_SPLICE_MODEL: DEFAULT_SPLICE_MODEL,
  DEFAULT_CONNECTOR_MODEL: DEFAULT_CONNECTOR_MODEL,
  cableAttenuation: cableAttenuation,
  splitterLoss: splitterLoss,
  launchWindowNote: launchWindowNote,
  upstreamNote: upstreamNote,
  opticalBudget: opticalBudget,
  pointToPoint: pointToPoint,
  computeOdn: computeOdn
};
