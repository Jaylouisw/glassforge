'use strict';
/**
 * The optical power budget: the arithmetic that decides whether a design lights.
 *
 * The model is the ordinary one a planner uses in the field:
 *
 *   P(rx) = P(tx,min) - [ fibre loss + splice loss + connector loss + splitter loss + allowance ]
 *
 * Worst case in, verdict out. Three things make this more than a subtraction:
 *
 * 1. **The loss is wavelength-specific.** 1490 nm downstream and 1310 nm upstream attenuate
 *    differently through the same glass, so a budget computed once at "fibre loss" is wrong for
 *    half the network. A cable that does not publish the window being asked for is an error -
 *    never a silent zero.
 * 2. **Two verdicts, not one.** The receiver has to see enough power (`headroomDb` above its
 *    sensitivity) *and* the ODN has to stay inside the PON class budget (`classHeadroomDb`). A
 *    link can pass the first and fail the second, and the class budget is the one the OLT vendor
 *    will hold you to.
 * 3. **A design margin is not optional.** A network that computes to 0.2 dB of headroom does not
 *    work in the rain; `marginDb` (default 3) is the design reserve, and it is separate from the
 *    measurement uncertainty of the parts.
 */

const partsModule = require('./parts');

const DEFAULT_SPLICE_MODEL = 'fusion';
const DEFAULT_CONNECTOR_MODEL = 'sc-apc';
const DEFAULT_MARGIN_DB = 3;
const DEFAULT_WAVELENGTH = { down: '1490', up: '1310' };

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
 * Run the budget.
 *
 * `design` (all lengths in metres):
 *   direction    'down' | 'up'                       (default 'down')
 *   wavelength   '1310' | '1490' | '1550'            (default 1490 down / 1310 up)
 *   olt          { model, txDbm? }
 *   ont          { model }
 *   spans        [{ cable: model, lengthM }]
 *   splitters    [{ model }]                         (cascade, in order from the OLT)
 *   splices      number | [{ model?, lossDb? }]      (default model: parts/splice/fusion)
 *   connectors   number | { count, model }
 *   allowanceDb  extra design allowance              (default 0)
 *   marginDb     design reserve required             (default 3)
 */
function opticalBudget(design, registry) {
  if (!design || typeof design !== 'object') throw new TypeError('opticalBudget needs a design object');
  if (!registry) throw new TypeError('opticalBudget needs a parts registry');

  const direction = design.direction === 'up' ? 'up' : 'down';
  const wavelength = String(design.wavelength || DEFAULT_WAVELENGTH[direction]);
  if (partsModule.WAVELENGTHS.indexOf(wavelength) === -1) {
    throw new Error('unknown wavelength "' + wavelength + '" - expected one of ' + partsModule.WAVELENGTHS.join(', '));
  }

  if (!design.olt || !design.olt.model) throw new TypeError('design.olt.model is required');
  if (!design.ont || !design.ont.model) throw new TypeError('design.ont.model is required');
  const olt = registry.get('olt', design.olt.model);
  const ont = registry.get('ont', design.ont.model);

  if (olt.pon !== ont.pon) {
    throw new Error('the OLT is ' + olt.pon + ' and the ONT is ' + ont.pon + ' - they cannot share a PON');
  }

  const marginDb = isNum(design.marginDb) ? design.marginDb : DEFAULT_MARGIN_DB;
  const allowanceDb = isNum(design.allowanceDb) ? design.allowanceDb : 0;
  const breakdown = [];

  // --- transmit power, worst case ------------------------------------------------
  const txSpec = direction === 'down'
    ? { min: olt.txPowerDbmMin, max: olt.txPowerDbmMax, who: 'OLT ' + olt.model }
    : { min: ont.txPowerDbmMin, max: ont.txPowerDbmMax, who: 'ONT ' + ont.model };
  let txDbm = txSpec.min;
  const warnings = [];
  if (design.txDbm !== undefined) {
    if (!isNum(design.txDbm)) throw new TypeError('design.txDbm must be a number when given');
    if (design.txDbm < txSpec.min || design.txDbm > txSpec.max) {
      warnings.push('requested transmit power ' + design.txDbm + ' dBm is outside the ' + txSpec.who +
        ' range ' + txSpec.min + '..' + txSpec.max + ' dBm');
    }
    txDbm = design.txDbm;
  }

  // --- fibre ---------------------------------------------------------------------
  const spans = design.spans || [];
  if (!Array.isArray(spans)) throw new TypeError('design.spans must be an array');
  let fibreDb = 0;
  spans.forEach(function (span, i) {
    if (!span || !span.cable) throw new TypeError('design.spans[' + i + '].cable is required');
    if (!isNum(span.lengthM) || span.lengthM < 0) throw new TypeError('design.spans[' + i + '].lengthM must be a non-negative number');
    const cable = registry.get('cable', span.cable);
    const dbPerKm = cableAttenuation(cable, wavelength);
    const db = dbPerKm * (span.lengthM / 1000);
    fibreDb += db;
    breakdown.push({
      kind: 'fibre',
      label: cable.model + ' ' + Math.round(span.lengthM) + ' m @ ' + wavelength + ' nm (' + dbPerKm + ' dB/km)',
      db: round(db, 3)
    });
  });
  if (!spans.length) warnings.push('no cable spans: this budget describes an OLT patched straight into an ONT');

  // --- splices -------------------------------------------------------------------
  let spliceLossDb = 0;
  const spliceInput = design.splices === undefined ? 0 : design.splices;
  if (Array.isArray(spliceInput)) {
    spliceInput.forEach(function (s, i) {
      const model = (s && s.model) || DEFAULT_SPLICE_MODEL;
      const part = s && isNum(s.lossDb) ? null : lossPart(registry, 'splice', model, DEFAULT_SPLICE_MODEL);
      const db = s && isNum(s.lossDb) ? s.lossDb : part.lossDb;
      spliceLossDb += db;
      breakdown.push({ kind: 'splice', label: 'splice ' + (i + 1) + ' (' + ((s && s.model) || model) + ')', db: round(db, 3) });
    });
  } else if (isNum(spliceInput) && spliceInput > 0) {
    const part = lossPart(registry, 'splice', design.spliceModel, DEFAULT_SPLICE_MODEL);
    if (!Number.isInteger(spliceInput)) throw new TypeError('design.splices must be an integer count or an array');
    spliceLossDb = part.lossDb * spliceInput;
    breakdown.push({ kind: 'splice', label: spliceInput + ' x ' + part.model + ' splice', db: round(spliceLossDb, 3) });
  }

  // --- connectors ----------------------------------------------------------------
  let connectorLossDb = 0;
  const connectorInput = design.connectors === undefined ? 0 : design.connectors;
  const connectorModel = (connectorInput && !isNum(connectorInput) && connectorInput.model) || design.connectorModel || DEFAULT_CONNECTOR_MODEL;
  const connectorCount = isNum(connectorInput) ? connectorInput : (connectorInput && isNum(connectorInput.count) ? connectorInput.count : 0);
  if (connectorCount > 0) {
    const part = lossPart(registry, 'connector', connectorModel, DEFAULT_CONNECTOR_MODEL);
    connectorLossDb = part.lossDb * connectorCount;
    breakdown.push({ kind: 'connector', label: connectorCount + ' x ' + part.model + ' connector', db: round(connectorLossDb, 3) });
  }

  // --- splitters -----------------------------------------------------------------
  let splitterLossDb = 0;
  const splitters = design.splitters || [];
  if (!Array.isArray(splitters)) throw new TypeError('design.splitters must be an array');
  let cascadeRatio = 1;
  splitters.forEach(function (s, i) {
    if (!s || !s.model) throw new TypeError('design.splitters[' + i + '].model is required');
    const part = registry.get('splitter', s.model);
    const db = splitterLoss(part);
    splitterLossDb += db;
    cascadeRatio *= part.ratio;
    breakdown.push({ kind: 'splitter', label: 'splitter ' + (i + 1) + ' 1:' + part.ratio + ' ' + part.model, db: round(db, 3) });
  });

  // --- totals --------------------------------------------------------------------
  const odnLossDb = round(fibreDb + spliceLossDb + connectorLossDb + splitterLossDb, 3);
  const totalLossDb = round(odnLossDb + allowanceDb, 3);
  const rxPowerDbm = round(txDbm - totalLossDb, 2);

  const rxSpec = direction === 'down'
    ? { sensitivity: ont.rxSensitivityDbm, overload: ont.rxOverloadDbm, who: 'ONT ' + ont.model }
    : { sensitivity: olt.rxSensitivityDbm, overload: olt.rxOverloadDbm, who: 'OLT ' + olt.model };

  const headroomDb = round(rxPowerDbm - rxSpec.sensitivity, 2);
  const budgetDb = olt.budgetDb;
  const classHeadroomDb = round(budgetDb - odnLossDb, 2);

  const reasons = [];
  if (rxPowerDbm > rxSpec.overload) {
    reasons.push(rxPowerDbm + ' dBm at the ' + rxSpec.who + ' is above its overload point ' + rxSpec.overload + ' dBm - too much power');
  }
  if (headroomDb < marginDb) {
    reasons.push('headroom ' + headroomDb + ' dB is below the ' + marginDb + ' dB design margin (sensitivity ' + rxSpec.sensitivity + ' dBm)');
  }
  if (classHeadroomDb < 0) {
    reasons.push('ODN loss ' + odnLossDb + ' dB exceeds the ' + olt.pon + ' ' + olt.class + ' budget of ' + budgetDb + ' dB');
  }
  if (cascadeRatio > (olt.maxSplitRatio || 128)) {
    reasons.push('splitter cascade is 1:' + cascadeRatio + ', beyond the OLT limit of 1:' + (olt.maxSplitRatio || 128));
  }

  let verdict;
  if (reasons.length) verdict = 'fail';
  else if (headroomDb < marginDb + 2 || classHeadroomDb < 1) verdict = 'marginal';
  else verdict = 'ok';

  return {
    ok: verdict !== 'fail',
    verdict: verdict,
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
    cascadeRatio: cascadeRatio,
    breakdown: breakdown,
    reasons: reasons,
    warnings: warnings
  };
}

module.exports = {
  DEFAULT_MARGIN_DB: DEFAULT_MARGIN_DB,
  DEFAULT_SPLICE_MODEL: DEFAULT_SPLICE_MODEL,
  DEFAULT_CONNECTOR_MODEL: DEFAULT_CONNECTOR_MODEL,
  cableAttenuation: cableAttenuation,
  splitterLoss: splitterLoss,
  opticalBudget: opticalBudget
};
