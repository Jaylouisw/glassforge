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
 * The passive side of any link: fibre, splices, connectors, splitters.
 *
 * Shared so the PON path and the active path charge exactly the same losses for the same plant.
 * Returns the individual sums as well as the total, because a report that cannot show its parts is
 * not reviewable.
 */
function computeOdn(design, wavelength, registry) {
  const breakdown = [];

  // --- fibre ---------------------------------------------------------------------
  const spans = design.spans || [];
  if (!Array.isArray(spans)) throw new TypeError('design.spans must be an array');
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
    if (!Number.isInteger(spliceInput)) throw new TypeError('design.splices must be an integer count or an array');
    const part = lossPart(registry, 'splice', design.spliceModel, DEFAULT_SPLICE_MODEL);
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
  let cascadeRatio = 1;
  const splitters = design.splitters || [];
  if (!Array.isArray(splitters)) throw new TypeError('design.splitters must be an array');
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
 * Run a PON budget.
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
  const warnings = [];
  const odn = computeOdn(design, wavelength, registry);
  if (!odn.spanCount) warnings.push('no cable spans: this budget describes an OLT patched straight into an ONT');

  // --- transmit power, worst case ------------------------------------------------
  const txSpec = direction === 'down'
    ? { min: olt.txPowerDbmMin, max: olt.txPowerDbmMax, who: 'OLT ' + olt.model }
    : { min: ont.txPowerDbmMin, max: ont.txPowerDbmMax, who: 'ONT ' + ont.model };
  let txDbm = txSpec.min;
  if (design.txDbm !== undefined) {
    if (!isNum(design.txDbm)) throw new TypeError('design.txDbm must be a number when given');
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
  if (odn.cascadeRatio > (olt.maxSplitRatio || 128)) {
    reasons.push('splitter cascade is 1:' + odn.cascadeRatio + ', beyond the OLT limit of 1:' + (olt.maxSplitRatio || 128));
  }

  const verdict = verdictFor(headroomDb, marginDb, classHeadroomDb, reasons);

  return {
    ok: verdict !== 'fail',
    verdict: verdict,
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
 *   headEnd   { model, txDbm? }        the optic at the aggregation end
 *   cpe       { model }                the optic at the customer end
 *   direction 'down' | 'up'            (default 'down')
 *   wavelength                         (default: the head-end optic's wavelength)
 *   spans, splices, connectors, allowanceDb, marginDb   — as for the PON budget
 *
 * The second verdict here is the link's own loss budget, `launch(min) − sensitivity`, rather than a
 * PON class: an active link has no class, it has two datasheets. Reach is checked separately, because
 * a link can be 3 dB inside its budget and still be 60 km down a 10 km optic.
 */
function pointToPoint(design, registry) {
  if (!design || typeof design !== 'object') throw new TypeError('pointToPoint needs a design object');
  if (!registry) throw new TypeError('pointToPoint needs a parts registry');
  if (!design.headEnd || !design.headEnd.model) throw new TypeError('design.headEnd.model is required (the optic at the aggregation end)');
  if (!design.cpe || !design.cpe.model) throw new TypeError('design.cpe.model is required (the optic at the customer end)');

  const headEnd = registry.get('transceiver', design.headEnd.model);
  const cpe = registry.get('transceiver', design.cpe.model);

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
    if (!isNum(design.txDbm)) throw new TypeError('design.txDbm must be a number when given');
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
  const budgetDb = round(headEnd.txPowerDbmMin - cpe.rxSensitivityDbm, 2);
  const headroomDb = round(rxPowerDbm - rxSpec.sensitivity, 2);
  const classHeadroomDb = round(budgetDb - odnLossDb, 2);
  const reachM = Math.min(headEnd.reachM, cpe.reachM);

  const reasons = [];
  if (rxPowerDbm > rxSpec.overload) {
    reasons.push(rxPowerDbm + ' dBm at the ' + rxSpec.who + ' is above its overload point ' + rxSpec.overload + ' dBm - too much power');
  }
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

  return {
    ok: verdict !== 'fail',
    verdict: verdict,
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
  DEFAULT_MARGIN_DB: DEFAULT_MARGIN_DB,
  DEFAULT_SPLICE_MODEL: DEFAULT_SPLICE_MODEL,
  DEFAULT_CONNECTOR_MODEL: DEFAULT_CONNECTOR_MODEL,
  cableAttenuation: cableAttenuation,
  splitterLoss: splitterLoss,
  opticalBudget: opticalBudget,
  pointToPoint: pointToPoint,
  computeOdn: computeOdn
};
