'use strict';
/**
 * Site-to-site (DC-to-DC) links: a circuit, not a tree.
 *
 * Auto-design answers "what do I build to serve these addresses": one root, one tree, every far end a
 * customer. A link is the other question - two named sites, an optic at each end, no splitter, no ONT -
 * and the normal requirement is that the two legs do not share duct. That makes it a *circuit*, and it
 * must not be squeezed into the plant model: two paths between the same pair of nodes is a cycle, and
 * `network.validate` is right to warn about a cycle in a tree.
 *
 * Three things this module adds to routing and budgeting, which already work:
 *
 * 1. **Link mode.** Legs are measured on the supplied duct/street graph (`street.diversePaths`), never
 *    by a straight line when a graph is present, and each leg is budgeted separately with
 *    `budget.pointToPoint` - its own reach, loss and overload verdicts. A protected circuit whose legs
 *    are asymmetric is two verdicts, not an average.
 * 2. **Diversity, stated.** Leg A and leg B are the minimum-cost edge-disjoint pair where the graph
 *    allows one (Suurballe); where it does not, the second leg is the path that shares the fewest
 *    metres, and every shared segment is reported with its metres. "Diverse except 180 m at the
 *    building entry" is the answer a planner needs, and it is printed rather than hidden.
 * 3. **Leased (third-party) segments.** A large share of these links is bought, not built. A leased
 *    segment carries a provider, a stated length and a stated loss: it contributes to the budget and
 *    to the cost, and it is excluded from the cable BOM, because nobody buys cable for someone else's
 *    duct.
 *
 * Lengths are reported three ways per leg, because they answer three questions: `routedM` (measured on
 * the graph), `ownM` (routed plus the site drops - the cable you buy) and `lengthM` (everything,
 * including leased segments - the path the light takes).
 */

const geo = require('./geo');
const street = require('./street');
const budget = require('./budget');
const lengthModule = require('./length');
const designModule = require('./design');
const designFields = require('./design-fields');

const DEFAULTS = {
  fibres: 2,
  connectors: 2,
  routeFactor: 1.2,
  marginDb: 3,
  maxSnapM: street.DEFAULT_MAX_SNAP_M,
  joinToleranceM: street.DEFAULT_JOIN_M,
  optic: 'sfp-plus-10g-lr-10km',
  closure: 'mufa-inline-24',
  direction: 'down',
  protection: 'diverse'
};

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 2 : places);
  return Math.round(n * f) / f;
}
function sum(list, pick) {
  return list.reduce(function (n, item) { return n + (pick ? pick(item) : item); }, 0);
}
function latLon(p) { return p.lat.toFixed(6) + ',' + p.lon.toFixed(6); }

function modelOf(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.model === 'string') return value.model;
  return null;
}

function siteOf(input, fallbackName) {
  if (!input) return null;
  return { name: input.name || fallbackName, lat: input.lat, lon: input.lon };
}

function protectionOf(value) {
  if (value === undefined || value === null || value === 'diverse') return 'diverse';
  if (value === 'single') return 'single';
  throw new Error('protection must be "diverse" or "single", got "' + value + '"');
}

/** Normalise what a caller may hand us, and refuse the shapes that cannot describe a link. */
function options(input) {
  // A site-to-site budget reads the same two knobs, so it refuses the same two values: a reserve
  // that is not a number is not a reserve, and a direction it cannot place is a different receiver
  // at a different wavelength - `direction` was answered as `down` and nothing said so.
  designFields.assertNumberField(input, 'marginDb', 0, 'the link design');
  designFields.assertChoiceField(input, 'direction', ['up', 'down'], 'the link design');
  // The routing, BOM and crew knobs below are normalised the same way and move a number the plan is
  // bought on: `routeFactor: '1.4'` fell back to 1.2 (a leg 15% short of what was asked for),
  // `splicesPerJoint: '2'` fell back to the fibre count (12 splices at every joint instead of 2), and
  // `overlengthPct: '10'` to the cable default. A string is exactly what a JSON form field arrives as.
  designFields.assertNumberField(input, 'routeFactor', 1, 'the link design', {
    measure: 'a number of metres of route per metre of straight line',
    unusable: 'A route factor the link design cannot read falls back to ' + DEFAULTS.routeFactor +
      ', so both legs are quoted on a route the caller did not ask for.',
    belowMin: 'A route factor below 1 claims a leg shorter than the crow flies, so it cannot be a ' +
      'tighter detour - it is a duct length nobody can build.'
  });
  designFields.assertNumberField(input, 'maxSnapM', 0, 'the link design', {
    measure: 'a number of metres',
    unusable: 'A snap radius the link design cannot read falls back to ' + DEFAULTS.maxSnapM +
      ' m, which attaches a site to a manhole it is not on and measures the leg from there.',
    belowMin: 'A negative snap radius attaches nothing, so it is a link with no route rather than a tight one.'
  });
  designFields.assertNumberField(input, 'joinToleranceM', 0, 'the link design', {
    measure: 'a number of metres',
    unusable: 'A join tolerance the link design cannot read falls back to ' + DEFAULTS.joinToleranceM +
      ' m, which joins duct segments the caller kept apart or leaves a corner open.',
    belowMin: 'A negative tolerance joins nothing, so it is a graph in pieces rather than a tight one.'
  });
  designFields.assertNumberField(input, 'overlengthPct', 0, 'the link design', {
    measure: 'a percentage of design length',
    unusable: 'An overlength the link BOM cannot read falls back to the cable default, so both legs ' +
      'are quoted short of what the caller asked to buy.',
    belowMin: 'A negative overlength quotes less cable than the legs measure, which is a BOM nobody can pull.'
  });
  designFields.assertNumberField(input, 'splicesPerJoint', 1, 'the link design', {
    measure: 'a number of splices per joint',
    unusable: 'A splices-per-joint the link design cannot read falls back to the fibre count, which ' +
      'bills a 24-fibre joint as 24 splices the crew does not make.',
    belowMin: 'A joint that splices nothing is not a cheaper joint - it is a cable that was cut and ' +
      'never joined, so the count has to be at least 1.'
  });
  const o = input || {};
  const sitesInput = o.sites || { a: o.a || o.from, b: o.b || o.to };
  const sites = {
    a: siteOf(sitesInput && sitesInput.a, 'Site A'),
    b: siteOf(sitesInput && sitesInput.b, 'Site B')
  };
  for (const key of ['a', 'b']) {
    const site = sites[key];
    if (!site) throw new TypeError('sites.' + key + ' { lat, lon } is required - a link has two ends');
    if (!isNum(site.lat) || !isNum(site.lon)) {
      throw new TypeError('sites.' + key + '.lat and .lon must be numbers (a site without coordinates is not a site)');
    }
    if (!geo.isCoordinate(site)) throw new Error('sites.' + key + ' is not a valid coordinate');
  }
  if (geo.distanceM(sites.a, sites.b) < 1) {
    throw new Error('sites A and B are the same place - a link needs two different sites');
  }

  const opticInput = o.optics || {};
  const fallbackOptic = o.optic || DEFAULTS.optic;
  const opticA = modelOf(opticInput.a !== undefined ? opticInput.a : (o.opticA || fallbackOptic));
  const opticB = modelOf(opticInput.b !== undefined ? opticInput.b : (o.opticB || fallbackOptic));
  if (!opticA) throw new TypeError('optics.a is required (the optic at site A)');
  if (!opticB) throw new TypeError('optics.b is required (the optic at site B)');

  const fibres = o.fibres === undefined ? DEFAULTS.fibres : o.fibres;
  if (!isNum(fibres) || !Number.isInteger(fibres) || fibres < 1) {
    throw new TypeError('fibres must be a positive integer (the fibre count per leg)');
  }
  const connectors = o.connectors === undefined ? DEFAULTS.connectors : o.connectors;
  if (!isNum(connectors) || !Number.isInteger(connectors) || connectors < 0) {
    throw new TypeError('connectors must be a non-negative integer (patch panels per leg, both ends)');
  }
  const splices = o.splices;
  if (splices !== undefined && (!isNum(splices) || !Number.isInteger(splices) || splices < 0)) {
    throw new TypeError('splices must be a non-negative integer when given (otherwise it follows the joints)');
  }

  return {
    sites: sites,
    optics: { a: opticA, b: opticB },
    fibres: fibres,
    connectors: connectors,
    splices: splices,
    splicesPerJoint: isNum(o.splicesPerJoint) ? o.splicesPerJoint : fibres,
    protection: protectionOf(o.protection),
    network: o.network || null,
    maxSnapM: isNum(o.maxSnapM) ? o.maxSnapM : DEFAULTS.maxSnapM,
    joinToleranceM: isNum(o.joinToleranceM) ? o.joinToleranceM : DEFAULTS.joinToleranceM,
    routeFactor: isNum(o.routeFactor) && o.routeFactor >= 1 ? o.routeFactor : DEFAULTS.routeFactor,
    marginDb: isNum(o.marginDb) ? o.marginDb : DEFAULTS.marginDb,
    direction: o.direction === 'up' ? 'up' : DEFAULTS.direction,
    cable: o.cable || null,
    ladder: Array.isArray(o.ladder) && o.ladder.length ? o.ladder : designModule.DEFAULT_LADDER,
    overlengthPct: isNum(o.overlengthPct) ? o.overlengthPct : undefined,
    closure: o.closure || DEFAULTS.closure,
    thirdParty: thirdPartySegments(o.thirdParty)
  };
}

/**
 * A leased segment: who owns it, how long it is, and what it costs in dB. All three are required - a
 * leased span whose loss is unknown is not a figure, and this tool refuses to assume zero.
 */
function thirdPartySegments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new TypeError('thirdParty must be an array of leased segments');
  return input.map(function (seg, i) {
    const where = 'thirdParty[' + i + ']';
    if (!seg || typeof seg !== 'object') throw new TypeError(where + ' must be an object');
    if (!seg.provider || typeof seg.provider !== 'string') {
      throw new TypeError(where + '.provider is required - a leased segment names who owns it');
    }
    if (!isNum(seg.lengthM) || seg.lengthM < 0) {
      throw new TypeError(where + '.lengthM must be a non-negative number (the stated length of the leased segment)');
    }
    if (!isNum(seg.lossDb) || seg.lossDb < 0) {
      throw new TypeError(where + '.lossDb must be a non-negative number - a leased segment states its loss, it is never assumed to be zero');
    }
    if (seg.leg !== undefined && seg.leg !== 'a' && seg.leg !== 'b' && seg.leg !== 'both') {
      throw new Error(where + '.leg must be "a", "b" or "both"');
    }
    return {
      provider: seg.provider,
      lengthM: round(seg.lengthM, 2),
      lossDb: round(seg.lossDb, 3),
      leg: seg.leg || 'both',
      cost: isNum(seg.cost) ? seg.cost : null,
      reference: seg.reference || null
    };
  });
}

/** Intermediate junctions on a leg: the places a joint closure sits, not every bend. */
function jointNodes(graph, nodes) {
  const out = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const id = nodes[i];
    const degree = (graph.adjacency.get(id) || []).length;
    if (degree < 3) continue;
    const node = graph.nodes.get(id);
    out.push({ nodeId: id, lat: node.lat, lon: node.lon, degree: degree });
  }
  return out;
}

/**
 * A span may use fewer strands than its cable carries, never more.
 *
 * `design.cableFor` answers with the largest cable in the ladder when nothing in the ladder fits, which
 * is correct for an auto-design tree (the tree bundles cables per span) and wrong for a circuit (one
 * cable per leg). An explicit `cable` is never checked by the ladder at all, so a 24-fibre link could be
 * designed on 2-fibre drop cable and come back `ok` with a BOM nobody can splice - the overbooking
 * `network.strandLedger` refuses in a plant. The refusal names the cables that would carry the count,
 * because "that one is too small" is only half an answer.
 */
function cableForFibres(cable, fibres, registry) {
  if (cable.fiberCount >= fibres) return cable;
  const fits = registry.all('cable')
    .filter(function (c) { return c.fiberCount >= fibres; })
    .map(function (c) { return c.model; })
    .sort();
  throw new Error('cable "' + cable.model + '" carries ' + cable.fiberCount +
    ' fibres but this link asks for ' + fibres + ' per leg - a span cannot use more strands than its cable has' +
    (fits.length
      ? '; cables that carry ' + fibres + ' fibres: ' + fits.join(', ')
      : '; no cable in the catalogue carries ' + fibres + ' fibres'));
}

function describeShared(segment) {
  if (segment.kind === 'site-spur') return segment.lengthM + ' m of site drop shared by both legs';
  return segment.lengthM + ' m of duct ' + latLon(segment.from) + ' -> ' + latLon(segment.to) +
    (segment.edgeId ? ' (' + segment.edgeId + ')' : '');
}

/**
 * The pad a budget asks for, whichever fault asked for it: an overload pads directly (`attenuator`),
 * a module that is only too loud at the top of its launch window pads via `launchWindowPad`. Null
 * when this direction asks for no pad, so a caller can tell "no pad" from "a pad of zero".
 *
 * The object is returned, not the number: `padDb` is the smallest pad that clears the fault and
 * `maxPadDb` the largest that still leaves this direction's margin and class, and a sentence that
 * names one size for both directions needs both halves to know whether that size can be bought.
 */
function requestedPad(result) {
  if (!result) return null;
  if (result.attenuator && isNum(result.attenuator.padDb)) return result.attenuator;
  if (result.launchWindowPad && isNum(result.launchWindowPad.padDb)) return result.launchWindowPad;
  return null;
}

/**
 * One pad sits in both paths of a circuit, so when both directions ask for one the report names the
 * single size to buy - but only a size both directions can take. `padDb` is a floor and `maxPadDb` a
 * ceiling per direction: a pad above the ceiling does not fix the link, it pushes that receiver below
 * sensitivity + margin with a part bought for it. Where the two windows do not overlap, no size is
 * offered and the sentence says the pair needs a different optic. At a 20 dB reserve neither direction
 * can take a pad at all, and naming one anyway told a planner to buy a part its own reason had just
 * ruled out (#203).
 */
function sharedPadSentence(down, up) {
  const downPad = requestedPad(down);
  const upPad = requestedPad(up);
  if (!downPad || !upPad) return '';
  const buy = Math.max(downPad.padDb, upPad.padDb);
  const limit = Math.min(downPad.maxPadDb, upPad.maxPadDb);
  if (downPad.fits && upPad.fits && buy <= limit) {
    return ' One pad is ODN loss in both directions: buy the larger, ' + buy + ' dB.';
  }
  const why = [];
  if (!downPad.fits) why.push('the downstream direction cannot take one at all');
  if (!upPad.fits) why.push('the upstream direction cannot take one at all');
  if (!why.length) {
    why.push('the ' + buy + ' dB the louder direction needs is over the ' + limit +
      ' dB the tighter one allows');
  }
  return ' No single pad clears both directions (' + downPad.padDb + ' dB downstream, ' + upPad.padDb +
    ' dB upstream) - ' + why.join(' and ') + ' - so this pair needs a different optic.';
}

/** One verdict for a set of them: any fail fails, else any marginal, else ok. Null for an empty set. */
function worstVerdict(verdicts) {
  if (!verdicts.length) return null;
  if (verdicts.indexOf('fail') !== -1) return 'fail';
  if (verdicts.indexOf('marginal') !== -1) return 'marginal';
  return 'ok';
}

/**
 * A link that cannot be drawn is still a report: the sites, the method, and the one reason it failed.
 * It is never a straight line pretending to be a duct route.
 */
function refusal(opts, context, reason) {
  return {
    ok: false,
    mode: 'link',
    technology: 'p2p',
    routeMethod: context.routeMethod,
    network: context.network,
    sites: sitesOf(opts, null),
    protection: { requested: opts.protection, achieved: false, legs: 0 },
    legs: [],
    paths: [],
    runs: [],
    diversity: {
      requested: opts.protection,
      achieved: false,
      method: context.method,
      legs: 0,
      sharedM: null,
      shared: [],
      leasedSharedM: 0,
      leasedShared: [],
      sentence: 'no route was found: ' + reason
    },
    // Nothing was built, so no lease rides a leg: the segments are still listed, marked unattached.
    thirdParty: thirdPartyReport(opts, []),
    bom: null,
    verdict: 'fail',
    // Nothing was routed, so there is no path to read in either direction.
    upstreamVerdict: null,
    reasons: [reason],
    warnings: [],
    notes: context.notes
  };
}

function sitesOf(opts, snaps) {
  function one(key) {
    const site = opts.sites[key];
    const snap = snaps && snaps[key] ? snaps[key] : null;
    return {
      name: site.name,
      lat: site.lat,
      lon: site.lon,
      onNetwork: snap ? { nodeId: snap.nodeId, lat: snap.at.lat, lon: snap.at.lon } : null,
      spurM: snap ? snap.spurM : null
    };
  }
  return { a: one('a'), b: one('b') };
}

/**
 * The leased side of the circuit, counted once per physical segment. A segment on `both` legs is one
 * purchase used twice, so it is not doubled in `totalM` or `cost` - but it IS a diversity gap, and the
 * caller is told so.
 *
 * A lease is in the totals only when it rides a leg this circuit actually has. A B-leg segment on a
 * one-leg circuit - `protection: 'single'`, or no graph to draw a second leg on - belongs to a leg that
 * was never built: the light never crosses it, so no budget is charged its loss, and nobody buys it.
 * Counting it anyway made the BOM quote a lease the circuit does not use (`thirdParty.totalM` read
 * 400 m while the one leg carried 100 m of lease), a purchase order for a duct the design does not
 * enter. Those segments are still listed, with `attached: false`, and summed in the `unattached*`
 * fields, because dropping one from the report silently is the other way to be wrong about money.
 */
function thirdPartyReport(opts, legIds) {
  const built = Array.isArray(legIds) ? legIds : [];
  const segments = opts.thirdParty.map(function (seg) {
    return {
      provider: seg.provider,
      lengthM: seg.lengthM,
      lossDb: seg.lossDb,
      leg: seg.leg,
      cost: seg.cost,
      reference: seg.reference,
      attached: seg.leg === 'both' ? built.length > 0 : built.indexOf(seg.leg) !== -1,
      onBothLegs: seg.leg === 'both' && built.length > 1
    };
  });
  const attached = segments.filter(function (seg) { return seg.attached; });
  const unattached = segments.filter(function (seg) { return !seg.attached; });
  function allPriced(list) { return list.every(function (seg) { return seg.cost !== null; }); }
  function costOf(list) {
    if (!list.length) return 0;
    return allPriced(list) ? sum(list, function (seg) { return seg.cost; }) : null;
  }
  return {
    segments: segments,
    totalM: round(sum(attached, function (seg) { return seg.lengthM; }), 2),
    lossDb: round(sum(attached, function (seg) { return seg.lossDb; }), 3),
    cost: costOf(attached),
    costComplete: allPriced(attached),
    unattached: unattached,
    unattachedM: round(sum(unattached, function (seg) { return seg.lengthM; }), 2),
    unattachedLossDb: round(sum(unattached, function (seg) { return seg.lossDb; }), 3),
    unattachedCost: costOf(unattached),
    unattachedCostComplete: allPriced(unattached),
    costUnit: 'unspecified: the caller states cost in whatever unit it buys in; this tool never invents a price',
    inCableBom: false
  };
}

/**
 * Design a site-to-site link.
 *
 * `input`:
 *   sites       { a: { name?, lat, lon }, b: { name?, lat, lon } }   (or `a`/`b`, or `from`/`to`)
 *   optics      { a: model, b: model }                              one optic at each end
 *   network     duct/street geometry: KML text, an array of polylines, or { edges: [...] }
 *   protection  'diverse' (default) | 'single'
 *   fibres, cable, ladder, connectors, splices, splicesPerJoint, marginDb, direction
 *   thirdParty  [{ provider, lengthM, lossDb, leg?: 'a'|'b'|'both', cost? }]
 *
 * Returns `{ ok, mode: 'link', routeMethod, sites, legs, paths, runs, diversity, thirdParty, bom,
 * verdict, reasons, warnings, notes }`. `ok: false` means at least one leg failed its budget or the
 * graph could not route it; the reasons name the leg and the figure.
 */
function design(input, registry) {
  if (!registry) throw new TypeError('link.design needs a parts registry');
  const opts = options(input);
  const notes = [];
  const warnings = [];

  const context = { routeMethod: 'straight-line x' + opts.routeFactor, network: null, method: 'straight-line', notes: notes };

  let graph = null;
  let snaps = null;
  if (opts.network) {
    graph = street.buildGraph(opts.network, { joinToleranceM: opts.joinToleranceM });
    const stats = graph.stats();
    context.network = stats;
    context.routeMethod = 'street-graph (' + stats.edges + ' edges, ' + stats.lengthKm + ' km)';
    notes.push('Both legs are routed along the ' + stats.edges + '-edge duct/street graph (' +
      stats.lengthKm + ' km of network); no length in this result is a straight-line estimate.');

    snaps = {};
    for (const key of ['a', 'b']) {
      const snapped = street.snap(graph, opts.sites[key], { maxSnapM: opts.maxSnapM });
      if (!snapped) {
        return refusal(opts, context, 'site ' + key.toUpperCase() + ' (' + opts.sites[key].name +
          ') is more than ' + opts.maxSnapM + ' m from the nearest duct/street edge - it is not on the network');
      }
      snaps[key] = snapped;
    }
  } else {
    notes.push('No duct/street network supplied: lengths are straight-line x' + opts.routeFactor +
      ' and no protected leg can be drawn without a graph.');
  }

  let routedLegs = [];
  let diversity = null;
  if (graph) {
    if (opts.protection === 'diverse') {
      const routed = street.diversePaths(graph, snaps.a.nodeId, snaps.b.nodeId);
      if (!routed) {
        return refusal(opts, context, 'the duct/street graph does not connect ' + opts.sites.a.name +
          ' to ' + opts.sites.b.name + ' - the two sites are on different components');
      }
      routedLegs = routed.legs;
      context.method = routed.method;
      diversity = {
        requested: 'diverse',
        method: routed.method,
        disjoint: routed.disjoint,
        shared: routed.shared,
        sharedM: routed.sharedM
      };
      if (routed.method === 'single-route') {
        notes.push('The graph offers exactly one route between the sites, so there is one leg and no protection.');
      }
    } else {
      const path = street.routePath(graph, snaps.a.nodeId, snaps.b.nodeId);
      if (!path) {
        return refusal(opts, context, 'the duct/street graph does not connect ' + opts.sites.a.name +
          ' to ' + opts.sites.b.name);
      }
      routedLegs = [path];
      context.method = 'shortest-path';
      diversity = { requested: 'single', method: 'shortest-path', disjoint: false, shared: [], sharedM: null };
    }
  } else {
    const chord = round(geo.distanceM(opts.sites.a, opts.sites.b) * opts.routeFactor, 2);
    routedLegs = [{
      nodes: [],
      edges: [],
      lengthM: chord,
      route: [{ lat: opts.sites.a.lat, lon: opts.sites.a.lon }, { lat: opts.sites.b.lat, lon: opts.sites.b.lon }]
    }];
    diversity = { requested: opts.protection, method: 'straight-line', disjoint: false, shared: [], sharedM: null };
  }

  const spurA = graph ? snaps.a.spurM : 0;
  const spurB = graph ? snaps.b.spurM : 0;
  const spurM = round(spurA + spurB, 2);
  const legs = [];

  routedLegs.forEach(function (routed, index) {
    const id = index === 0 ? 'a' : 'b';
    const label = index === 0 ? 'A-leg' : 'B-leg';
    const ownM = round(routed.lengthM + spurM, 2);
    const leased = opts.thirdParty.filter(function (seg) { return seg.leg === 'both' || seg.leg === id; });
    const leasedM = round(sum(leased, function (seg) { return seg.lengthM; }), 2);
    const joints = graph ? jointNodes(graph, routed.nodes) : [];
    // The drawn leg covers the cable the leg buys. `routed.route` is the duct geometry between the two
    // snap points; the site drops (`spurA`, `spurB`) are measured into `ownM` and paid for by the BOM,
    // so leaving them out of the route drew a circuit that ended at a manhole 44.5 m from the building
    // while the cable line billed the last metres. Auto-design attaches the terminal to a run for the
    // same reason. Only a non-zero drop is added, so a site already on the duct is not pinned twice.
    const route = routed.route.slice();
    if (spurA > 0) route.unshift({ lat: opts.sites.a.lat, lon: opts.sites.a.lon });
    if (spurB > 0) route.push({ lat: opts.sites.b.lat, lon: opts.sites.b.lon });
    // One splice event per joint on the path, not one per strand. A joint splices every strand the
    // cable carries - that is the crew's count (`splices`, below, times `splicesPerJoint`) - but the
    // light on any one strand crosses the joint once, which is what the budget charges (SPEC §3: "a
    // closure node: one splice"). Handing the crew's count to `budget.pointToPoint` charged a 24-fibre
    // leg 24 splices at a single joint and lost 2.3 dB to the cable's fibre count: the same duct route
    // came out `ok` on 2 fibres and `fail` on 24 with no change to the glass or the optics.
    const spliceEvents = opts.splices !== undefined ? opts.splices : joints.length;
    const splices = round(spliceEvents * opts.splicesPerJoint, 0);
    const cable = cableForFibres(
      opts.cable
        ? registry.get('cable', opts.cable)
        : designModule.cableForSpan(opts.fibres, ownM, opts.ladder, registry),
      opts.fibres, registry)

    // One path of glass, so both directions are the same ODN: the inputs are built once and only the
    // launch and the receiver change with `direction`. A fresh object per call because the budget
    // reads the arrays it is handed.
    function budgetInputs(direction) {
      return {
        headEnd: { model: opts.optics.a },
        cpe: { model: opts.optics.b },
        spans: ownM > 0 ? [{ cable: cable.model, lengthM: ownM }] : [],
        splices: spliceEvents,
        connectors: opts.connectors,
        thirdParty: leased.map(function (seg) {
          return { provider: seg.provider, lengthM: seg.lengthM, lossDb: seg.lossDb };
        }),
        marginDb: opts.marginDb,
        direction: direction
      };
    }
    const budgetResult = budget.pointToPoint(budgetInputs(opts.direction), registry);
    budgetResult.warnings.forEach(function (w) { warnings.push(label + ': ' + w); });

    // A circuit is two links over one path: A launches into B at one wavelength, B launches into A
    // at the other. `pointToPoint` answers either direction (`direction: 'up'` reads the head-end
    // receiver), but the report only ever asked for the requested one, defaulting to down - so a 1G
    // circuit with an LX at the near end and an EX at the far end came back `ok` while the same ODN
    // read upstream was `fail`: the far optic launches -1 dBm into the head-end receiver's -3 dBm
    // overload point, and the fix is a 5 dB pad, not more reach. The two directions are not symmetric
    // whenever the ends are different optics, and a circuit's report is where that has to show.
    // This is the gap #185 fixed on the plant surfaces, with the same treatment: the upstream verdict
    // is reported (`upstream`, `upstreamVerdict`) and warned about by name, but `verdict` stays the
    // direction the caller asked for - gating a design on its upstream direction is the open decision
    // in #185/#111, and this module does not take it here.
    //
    // Only a failing direction is warned about, never its `warnings`: the launch-window band asks for
    // a pad sized from one receiver, and a second pad sentence for the same glass reads as a second
    // pad to buy. When both directions name a pad, the sentence says which size to buy - if a size
    // that clears both exists at all.
    const up = opts.direction === 'up' ? budgetResult : budget.pointToPoint(budgetInputs('up'), registry);
    if (up !== budgetResult && up.verdict === 'fail') {
      warnings.push(label + ': fails upstream over the same path - ' + up.reasons.join('; ') +
        sharedPadSentence(budgetResult, up));
    }

    legs.push({
      id: id,
      label: label,
      optics: { a: opts.optics.a, b: opts.optics.b },
      routedM: round(routed.lengthM, 2),
      spurM: spurM,
      ownM: ownM,
      leasedM: leasedM,
      lengthM: round(ownM + leasedM, 2),
      joints: joints,
      spliceEvents: spliceEvents,
      splices: splices,
      cable: cable.model,
      fiberCount: cable.fiberCount,
      edges: routed.edges.map(function (edge) { return edge.edgeId; }),
      route: route,
      budget: budgetResult,
      verdict: budgetResult.verdict,
      // Always the upstream direction, whatever `direction` asked for: when the caller asked for
      // `up` this is the same object as `budget`, never a field that quietly means "the other one".
      upstream: up,
      upstreamVerdict: up.verdict
    });
  });

  // A leased segment on a leg that was never built is dropped from the budget and the cost, so the
  // warning has to say which one and why. `protection: 'single'` is the obvious case; the other is a
  // diverse request with no graph to draw a second leg on, which is one straight-line leg and no B-leg.
  const builtLegs = legs.map(function (leg) { return leg.id; });
  const orphaned = opts.thirdParty.filter(function (seg) {
    return seg.leg !== 'both' && builtLegs.indexOf(seg.leg) === -1;
  });
  if (orphaned.length) {
    warnings.push((opts.protection === 'single'
      ? 'protection is single'
      : 'no B-leg could be drawn (this circuit has one leg)') +
      ', so the leased segment(s) assigned to the B-leg (' +
      orphaned.map(function (seg) { return seg.provider; }).join(', ') + ') are not part of the circuit');
  }

  // ---- diversity report ---------------------------------------------------------
  const shared = (diversity.shared || []).slice();
  let sharedM = diversity.sharedM === null || diversity.sharedM === undefined ? 0 : diversity.sharedM;
  if (legs.length > 1 && spurM > 0) {
    shared.push({ kind: 'site-spur', edgeId: null, lengthM: spurM, from: opts.sites.a, to: opts.sites.b });
    sharedM = round(sharedM + spurM, 2);
  }
  const leasedShared = legs.length > 1 ? opts.thirdParty.filter(function (seg) { return seg.leg === 'both'; }) : [];
  const leasedSharedM = round(sum(leasedShared, function (seg) { return seg.lengthM; }), 2);
  const achieved = legs.length > 1 && sharedM === 0 && leasedSharedM === 0;

  let sentence;
  if (legs.length < 2) {
    sentence = diversity.method === 'straight-line'
      ? 'one straight-line leg: without a graph no protected pair can be drawn'
      : 'one leg only: the graph offers a single route between the sites, so the circuit is unprotected';
  } else if (achieved) {
    sentence = 'the two legs are edge-disjoint along the supplied graph: ' + legs[0].routedM.toFixed(1) +
      ' m and ' + legs[1].routedM.toFixed(1) + ' m, 0 m shared';
  } else {
    const bits = [];
    if (sharedM > 0) {
      bits.push(sharedM + ' m across ' + shared.length + ' shared segment(s): ' +
        shared.map(describeShared).join('; '));
    }
    if (leasedSharedM > 0) {
      const providers = leasedShared.map(function (seg) { return seg.provider; });
      bits.push('a ' + leasedSharedM + ' m leased segment (' + providers.join(', ') + ') carried on both legs');
    }
    sentence = 'diverse except ' + bits.join(' and ');
  }

  if (opts.protection === 'diverse' && !achieved) {
    warnings.push('protection was requested but the legs are not diverse: ' + sentence);
  }

  // ---- bill of materials --------------------------------------------------------
  const bomSpans = legs.filter(function (leg) { return leg.ownM > 0; }).map(function (leg) {
    return {
      id: 'link-' + leg.id,
      from: opts.sites.a.name,
      to: opts.sites.b.name,
      cable: leg.cable,
      lengthM: leg.ownM,
      splices: leg.splices,
      closures: leg.joints.length
    };
  });
  const plantBom = bomSpans.length
    ? lengthModule.billOfMaterials({ spans: bomSpans }, registry,
      opts.overlengthPct === undefined ? {} : { overlengthPct: opts.overlengthPct })
    : { lines: [], byCable: [] };
  const byCable = plantBom.byCable;
  const thirdParty = thirdPartyReport(opts, legs.map(function (leg) { return leg.id; }));
  const bom = {
    cable: byCable,
    lengths: plantBom.lines,
    cableM: round(sum(bomSpans, function (span) { return span.lengthM; }), 2),
    designM: round(sum(byCable, function (row) { return row.designM; }), 2),
    fibreMetres: round(sum(byCable, function (row) { return row.designM * row.fiberCount; }), 1),
    drums: sum(byCable, function (row) { return row.drums; }),
    splices: sum(legs, function (leg) { return leg.splices; }),
    closures: {
      model: opts.closure,
      count: sum(legs, function (leg) { return leg.joints.length; })
    },
    connectors: { model: budget.DEFAULT_CONNECTOR_MODEL, count: opts.connectors * legs.length },
    thirdParty: thirdParty,
    leasedTotalM: thirdParty.totalM
  };

  const verdicts = legs.map(function (leg) { return leg.verdict; });
  const verdict = verdicts.indexOf('fail') !== -1 ? 'fail'
    : (verdicts.indexOf('marginal') !== -1 ? 'marginal' : 'ok');
  const reasons = [];
  legs.forEach(function (leg) {
    leg.budget.reasons.forEach(function (reason) { reasons.push(leg.label + ': ' + reason); });
  });

  return {
    ok: verdict !== 'fail' && legs.length > 0,
    mode: 'link',
    technology: 'p2p',
    routeMethod: context.routeMethod,
    network: context.network,
    sites: sitesOf(opts, snaps),
    protection: {
      requested: opts.protection,
      achieved: achieved,
      legs: legs.length,
      method: diversity.method
    },
    legs: legs,
    paths: legs.map(function (leg) {
      return { id: leg.id, lengthM: leg.lengthM, edges: leg.edges, route: leg.route };
    }),
    runs: legs.map(function (leg) {
      return {
        id: 'link-' + leg.id,
        leg: leg.id,
        from: opts.sites.a.name,
        to: opts.sites.b.name,
        cable: leg.cable,
        lengthM: leg.lengthM,
        routedM: leg.routedM,
        ownM: leg.ownM,
        leasedM: leg.leasedM,
        purpose: 'link',
        method: context.routeMethod,
        route: leg.route
      };
    }),
    diversity: {
      requested: opts.protection,
      achieved: achieved,
      method: diversity.method,
      legs: legs.length,
      shared: shared,
      sharedM: legs.length > 1 ? round(sharedM, 2) : null,
      leasedShared: leasedShared,
      leasedSharedM: leasedSharedM,
      sentence: sentence
    },
    thirdParty: thirdParty,
    bom: bom,
    verdict: verdict,
    // The other half of the circuit, for a caller that reads one field instead of walking `legs`.
    // The worst of the legs, so a protected pair is only ok upstream when both legs are.
    upstreamVerdict: worstVerdict(legs.map(function (leg) { return leg.upstreamVerdict; })),
    reasons: reasons,
    warnings: warnings,
    notes: notes
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  design: design,
  jointNodes: jointNodes,
  thirdPartySegments: thirdPartySegments
};
