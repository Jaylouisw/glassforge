'use strict';
/**
 * Topology synthesis: a list of addresses and a head-end in, a designed plant out.
 *
 * Three topologies, built from the same demand, then scored against each other:
 *
 *   pon                head-end ── feeder tree ── splitters ── distribution tree ── ONTs
 *   active-tree        head-end ── one cable tree with closures ── ONTs on dedicated fibres
 *   active-home-run    head-end ── one dedicated cable per ONT
 *
 * **Every build is a tree over a routing provider**, and there are two providers:
 *
 *   euclid   minimum spanning tree over straight-line distances x `routeFactor` (default 1.2)
 *   street   union of shortest paths over an imported street/duct graph (`engine/street.js`)
 *
 * Supplying `opts.network` switches the provider, and every response says which one measured the
 * runs (`routeMethod`, and per run in `runs[]`). With a street graph the geometry is carried on the
 * span as `route`, so a drawing follows the streets and the BOM follows the drawing.
 *
 * Each candidate is a real plant: it goes through `network.validate`, every ONT on it gets its own
 * budget, and a candidate that fails either is reported with the reason and its numbers rather than
 * dropped from the comparison. The winner is the cheapest feasible candidate by fibre-metres (or by
 * money, when a cost model is supplied), with cable metres, splices, closures and optic speed as
 * tie-breaks.
 *
 * Nothing here is random. Centres, tie-breaks and iteration order are all in index order, so the same
 * demand and options always produce the same design - which is what makes the tests worth having and
 * a re-run comparable.
 */

const geo = require('./geo');
const network = require('./network');
const demandModule = require('./demand');
const designFields = require('./design-fields');
const lengthModule = require('./length');
const street = require('./street');
const budgetModule = require('./budget');

const DEFAULT_LADDER = [
  'g652d-loose-144', 'g652d-loose-96', 'g652d-loose-48', 'g652d-loose-24', 'g652d-loose-12',
  'g657a2-drop-2', 'g657a2-drop-1'
];

const DEFAULTS = {
  technology: 'auto',
  routeFactor: 1.2,
  marginDb: 3,
  network: null,
  maxSnapM: street.DEFAULT_MAX_SNAP_M,
  joinToleranceM: street.DEFAULT_JOIN_M,
  pon: {
    ratios: [8, 16, 32],
    olt: 'gpon-c-plus-8',
    ont: 'gpon-ont-4ge',
    maxDropM: 500
  },
  active: {
    headEndOptic: 'sfp-plus-10g-lr-10km',
    cpeOptic: 'sfp-plus-10g-lr-10km',
    optics: [
      { headEndOptic: 'sfp-1g-lx-10km', cpeOptic: 'sfp-1g-lx-10km' },
      { headEndOptic: 'sfp-plus-10g-lr-10km', cpeOptic: 'sfp-plus-10g-lr-10km' },
      { headEndOptic: 'sfp-plus-10g-er-40km', cpeOptic: 'sfp-plus-10g-er-40km' }
    ]
  },
  ladder: DEFAULT_LADDER,
  overlengthPct: 3,
  kmeansIterations: 8
};

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 1 : places);
  return Math.round(n * f) / f;
}
function cmpIds(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Validate the caller's cost model, because a money objective is only as good as its price list.
 *
 * The engine used to read `costs.cablePerM[line.model]` and charge 0 for a cable the caller had not
 * priced. That is defaulting a missing figure to zero - the one thing this engine refuses to do with
 * attenuation, and it is worse here: cable is the dominant term of a fibre BOM, so a partial list
 * ranks a design by its splices while the response says `objective: "cost"`. A cable the model leaves
 * unpriced is caught later, per candidate, because only a built design knows which cables it uses;
 * this function catches the shapes and the entries that are wrong on their face.
 */
function costModel(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('costs must be an object: { cablePerM: { model: n }, splice, closure, splitter }');
  }
  if (input.cablePerM === undefined) {
    throw new TypeError('costs.cablePerM is required when a cost model is supplied - cable is the term a money objective is mostly made of; omit costs to rank by fibre-metres');
  }
  if (typeof input.cablePerM !== 'object' || input.cablePerM === null || Array.isArray(input.cablePerM)) {
    throw new TypeError('costs.cablePerM must be an object of { cable model: price per metre }');
  }
  const prices = {};
  for (const model of Object.keys(input.cablePerM)) {
    const value = input.cablePerM[model];
    if (!isNum(value) || value < 0) {
      throw new TypeError('costs.cablePerM["' + model + '"] must be a non-negative number, got ' + JSON.stringify(value));
    }
    prices[model] = value;
  }
  const out = { cablePerM: prices };
  for (const key of ['splice', 'closure', 'splitter']) {
    if (input[key] === undefined) continue;
    if (!isNum(input[key]) || input[key] < 0) {
      throw new TypeError('costs.' + key + ' must be a non-negative number, got ' + JSON.stringify(input[key]));
    }
    out[key] = input[key];
  }
  return out;
}

/**
 * A value said back the way the caller sent it, for an option block of the wrong shape.
 *
 * JSON.stringify is what keeps a string a string: `String('16')` prints `16`, which reads as the
 * number the caller meant, so a refusal built on `String` argues with a value that looks right.
 */
function showOption(value) {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value); } catch (err) { return String(value); }
}

/**
 * A nested option block that is not an object is refused, because `Object.assign` merges nothing.
 *
 * `pon: 'gpon'` and `active: 'sfp'` were both accepted: the string's character keys landed on a copy
 * of the defaults and the design ran on `DEFAULTS.pon.ratios` / `DEFAULTS.active.optics` - a plant
 * built and ranked from parts the caller never named, answered with a 200 and no note. A block is a
 * set of named options, so anything else is a caller mistake and is refused by name.
 */
function assertOptionBlock(block, name, known) {
  if (block === undefined) return;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new TypeError('the design reads "' + name + '" as an object of ' + known.join(', ') + ' and got ' +
      showOption(block) + '. A block of another shape is refused rather than merged into the defaults, ' +
      'because the design would then design and rank a plant from options the caller did not name.');
  }
  designFields.assertKnownFields(block, known, 'the design\'s "' + name + '" block');
}

/**
 * The PON search's own options: the split ratios to try, the drop limit, the parts.
 *
 * `pon` is merged into `DEFAULTS.pon` with `Object.assign`, so before this guard a value the design
 * could not read was not reported - it was replaced, and the search then ran on the default:
 *
 *   ratios: '16'      a string is iterated *by character*, so the search tried 1:1 and 1:6, found no
 *                     such splitter, and answered "no candidate topology could be built for
 *                     technology \"pon\"" - the estate blamed for a missing pair of brackets.
 *   ratios: '8'       one character, so it designed the 1:8 plant the caller meant. Luck, not a read.
 *   ratios: []        searched nothing and then fell through to the active topologies.
 *   ratios: [8.5]     looked up `plc-1x8.5-sca` and reported it as a missing part.
 *   maxDropM: -5      no house is within -5 m of a splitter, so the clustering gave every house its
 *                     own 1:1 site: 8 splitter sites and 557.9 m of design length on an estate whose
 *                     shared tree is 707.3 m. Fewer metres to buy, so it *won* the ranking.
 *
 * `pon.olt` and `pon.ont` are left to the registry, which refuses an unknown model by naming the ones
 * the catalogue has - that refusal is already better than anything this module could add.
 */
function assertPonOptions(block) {
  assertOptionBlock(block, 'pon', Object.keys(DEFAULTS.pon));
  if (block === undefined) return;
  const ratios = block.ratios;
  if (ratios !== undefined) {
    if (!Array.isArray(ratios)) {
      throw new TypeError('the design reads "pon.ratios" as a list of splitter ratios and got ' +
        showOption(ratios) + '. The list is read by iterating it: a string is iterated by character, ' +
        'so "16" would try 1:1 and 1:6, and a bare number is not a list at all. Pass e.g. [8, 16, 32], ' +
        'or omit the field for the default ' + DEFAULTS.pon.ratios.join(', ') + '.');
    }
    if (!ratios.length) {
      throw new TypeError('the design reads "pon.ratios" as at least one splitter ratio and got an empty ' +
        'list. Omitting the field is how the default is taken (' + DEFAULTS.pon.ratios.join(', ') +
        '); an empty list is refused rather than read as that default, because the search it describes ' +
        'buys no splitter at all and the design then falls through to the active topologies.');
    }
    for (let i = 0; i < ratios.length; i++) {
      const ratio = ratios[i];
      if (typeof ratio !== 'number' || !isFinite(ratio) || !Number.isInteger(ratio) || ratio < 2) {
        throw new TypeError('the design reads "pon.ratios" as whole splitter ratios of at least 2 and got ' +
          showOption(ratio) + ' at position ' + i + '. A splitter is 1:N with N a whole number of 2 or ' +
          'more - 1:0 and 1:8.5 are not parts, and this one would be looked up as "plc-1x' +
          String(ratio) + '-sca".');
      }
    }
  }
  designFields.assertNumberField(block, 'maxDropM', 0, 'the design\'s "pon" block', {
    measure: 'a number of metres',
    unusable: 'A drop limit the design cannot read falls back to ' + DEFAULTS.pon.maxDropM +
      ' m, so every house is placed against a reach the caller did not ask for.',
    belowMin: 'A negative drop limit says no house is within reach of its splitter, and the clustering ' +
      'then gives every house its own 1:1 site - a plant of closures and splitters that is cheaper to ' +
      'cable than the shared tree, so it is ranked as the answer.'
  });
}

/** The optic ends a pair is made of, in the order a refusal should name them. */
const OPTIC_ENDS = ['headEndOptic', 'cpeOptic'];

/**
 * The active search's optics, refused when a pair is not a pair.
 *
 * `optics` decides which parts the whole active design is built from, and it was read the same way:
 *
 *   optics: 'sfp-1g-lx-10km'    not a list, so `Array.isArray` failed and the design searched the
 *                               three DEFAULT pairs, then answered with a 10G LR-10KM plant.
 *   optics: []                  the same fallback, one default pair instead of three.
 *   optics: [{}]                each end took the default of its own generation, so the plan was a
 *                               10G LR pair nobody chose.
 *   optics: [{ cpeOptic: 1G }]  paired the caller's 1G CPE with the default 10G head-end optic and
 *                               reported every ONT as "the optics run at different rates" - six rows
 *                               blaming the estate for a field the caller left out.
 *
 * An end may be named once for the whole block (`active: { headEndOptic, optics: [{ cpeOptic }] }`),
 * which is the documented shape, so an entry is only refused when the end is named nowhere: filling it
 * from the *default* is the substitution this guard exists to stop.
 */
function assertActiveOptions(block) {
  assertOptionBlock(block, 'active', Object.keys(DEFAULTS.active));
  if (block === undefined) return;
  const optics = block.optics;
  if (optics === undefined) return;
  const defaultPairs = DEFAULTS.active.optics.map(function (pair) {
    return pair.headEndOptic + '/' + pair.cpeOptic;
  }).join(', ');
  if (!Array.isArray(optics)) {
    throw new TypeError('the design reads "active.optics" as a list of { headEndOptic, cpeOptic } pairs ' +
      'and got ' + showOption(optics) + '. A value of another shape is refused rather than replaced: the ' +
      'design would search the default pairs (' + defaultPairs + ') and answer with a plant built from ' +
      'optics the caller never named.');
  }
  if (!optics.length) {
    throw new TypeError('the design reads "active.optics" as at least one optic pair and got an empty list. ' +
      'Omitting the field is how the default is taken (it searches ' + defaultPairs + '); an empty list is ' +
      'refused rather than read as the single default pair, so a caller who meant to narrow the search ' +
      'does not get a design chosen for them.');
  }
  for (let i = 0; i < optics.length; i++) {
    const pair = optics[i];
    if (typeof pair !== 'object' || pair === null || Array.isArray(pair)) {
      throw new TypeError('the design reads "active.optics" as { headEndOptic, cpeOptic } pairs and got ' +
        showOption(pair) + ' at position ' + i + '. Each entry is one optic at each end of the link.');
    }
    for (const end of OPTIC_ENDS) {
      const model = pair[end];
      if (typeof model === 'string' && model !== '') continue;
      const named = block[end];
      if (typeof named === 'string' && named !== '') continue;
      throw new TypeError('the design reads "active.optics" as { headEndOptic, cpeOptic } pairs and the ' +
        'entry at position ' + i + ' names no "' + end + '", and nor does "active.' + end + '". A pair is ' +
        'two optics: an end that is named nowhere is filled from the default "' + DEFAULTS.active[end] +
        '", so the design is built from a part nobody chose and the ONTs then fail as "the optics run at ' +
        'different rates" rather than naming the missing field. Name both ends, e.g. ' +
        showOption({ headEndOptic: 'sfp-1g-lx-10km', cpeOptic: 'sfp-1g-lx-10km' }) + '.');
    }
  }
}

/**
 * Every top-level option the design reads - and the last list that was read without a key guard.
 *
 * The guards inside `options` check the *values* of the knobs they know, and the nested `pon`/`active`
 * blocks refuse a near miss by name; a top-level key one letter or one case off was neither. It is not
 * a setting the design rejects - it is not a key at all, so the default ran and the answer looked
 * complete. Measured on this engine, 12 houses over 0.8 km of diagonal:
 *
 *   { marginDb: 40 }      no candidate is feasible - a 40 dB reserve refuses the estate
 *   { margindb: 40 }      ok: true, the 3 dB default, a winner at 3.56 dB of worst headroom:
 *                         the design the caller's own reserve exists to reject
 *   { overlengthPct: 10 } designM 2088.1 m
 *   { overlengthpct: 10 } designM 1955.2 m - the 3% default, 132.9 m of cable short on a BOM
 *
 * The budget design object, the link design and the cable calculation have refused a near miss by
 * name since #137/#157/#192. This is the same rule at the one entry point whose answer is a plant,
 * a ranking and a purchase order, so it is refused here too rather than skipped.
 */
const DESIGN_OPTION_FIELDS = ['headEnd', 'technology', 'routeFactor', 'marginDb', 'network',
  'maxSnapM', 'joinToleranceM', 'pon', 'active', 'ladder', 'overlengthPct', 'costs',
  'kmeansIterations', 'includeAllPlants'];

function options(input, registry) {
  const o = input || {};
  designFields.assertKnownFields(o, DESIGN_OPTION_FIELDS, 'the design', {
    noun: 'option',
    consequence: 'A design option the engine ignores does not narrow or widen anything: the default ' +
      'runs, and every metre, drum and verdict in the answer is computed on a setting the caller did ' +
      'not name, so a near miss is refused rather than skipped.'
  });
  // A reserve is read straight into the verdict of every ONT in the design, so a value the budget
  // cannot use is refused here rather than defaulted: `marginDb: '3'` was replaced by 3 (right by
  // luck), and `marginDb: -5` passed through to every candidate - which then came back infeasible,
  // one copy of the refusal per demand point, instead of one sentence naming the field.
  designFields.assertNumberField(o, 'marginDb', 0, 'the design');
  // The routing and BOM knobs are read the same way, and for the same measured reason: each is
  // normalised with `isNum(x) ? x : default`, so a value the design cannot use silently becomes the
  // default and every length in the plan follows it. `routeFactor: '1.6'` (a string, which is what a
  // form field arrives as) designed a 690 m estate at 707 m of route instead of 940 m;
  // `overlengthPct: '10'` quoted 707 m of design length at 3% instead of 10%, 48 m short in the BOM.
  designFields.assertNumberField(o, 'routeFactor', 1, 'the design', {
    measure: 'a number of metres of route per metre of straight line',
    unusable: 'A route factor the design cannot read falls back to ' + DEFAULTS.routeFactor +
      ', so every span, drum and fibre-metre in the plan is measured on a route the caller did not ask for.',
    belowMin: 'A route factor below 1 claims a route shorter than the crow flies, so it cannot be a ' +
      'tighter detour - it is a plan whose lengths understate the duct somebody has to build.'
  });
  designFields.assertNumberField(o, 'maxSnapM', 0, 'the design', {
    measure: 'a number of metres',
    unusable: 'A snap distance the design cannot read falls back to ' + DEFAULTS.maxSnapM +
      ' m, which moves a property onto a street it is not on and measures the drop from there.',
    belowMin: 'A negative snap radius places nothing, so it is a design with no properties on the graph ' +
      'rather than a tight one.'
  });
  designFields.assertNumberField(o, 'joinToleranceM', 0, 'the design', {
    measure: 'a number of metres',
    unusable: 'A join tolerance the design cannot read falls back to ' + DEFAULTS.joinToleranceM +
      ' m, which joins street segments the caller kept apart or leaves a corner open.',
    belowMin: 'A negative tolerance joins nothing, so it is a graph in pieces rather than a tight one.'
  });
  designFields.assertNumberField(o, 'overlengthPct', 0, 'the design', {
    measure: 'a percentage of design length',
    unusable: 'An overlength the BOM cannot read falls back to ' + DEFAULTS.overlengthPct +
      '%, so every cable length in the plan is quoted short of what the caller asked to buy.',
    belowMin: 'A negative overlength quotes less cable than the route measures, which is a BOM nobody ' +
      'can pull.'
  });
  designFields.assertChoiceField(o, 'technology', ['auto', 'pon', 'active'], 'the design', {
    wrong: 'A technology it cannot place is refused rather than searched: "PON" is not "pon", and the ' +
      'answer to it was "no candidate topology could be built", which blames the estate for a typo.'
  });
  // `ladder` is what every span is bought from, and it was the last knob still falling back to the
  // default on a shape it could not use - a bare model name read as DEFAULT_LADDER, and a model the
  // catalogue does not have noticed only if a span happened to ask for it. An absent or empty ladder
  // is legitimate; anything else present is refused by name, at its position (see design-fields).
  designFields.assertCableLadder(o.ladder, function (model) { return registry.has('cable', model); },
    registry.all('cable').map(function (cable) { return cable.model; }), 'the design');
  // The nested blocks were the last unguarded options after #157, and each one fails the same way:
  // `Object.assign` replaces a shape the design cannot read instead of reporting it, so the plant is
  // built and ranked from options nobody named - see `assertPonOptions` and `assertActiveOptions`.
  //
  // Only the block the chosen technology reads is guarded. A caller who sends one form with both
  // blocks always is not wrong, and a `pon` block beside `technology: 'active'` is not a setting.
  const wanted = o.technology || DEFAULTS.technology;
  if (wanted === 'auto' || wanted === 'pon') assertPonOptions(o.pon);
  if (wanted === 'auto' || wanted === 'active') assertActiveOptions(o.active);

  return {
    technology: o.technology || DEFAULTS.technology,
    routeFactor: isNum(o.routeFactor) && o.routeFactor >= 1 ? o.routeFactor : DEFAULTS.routeFactor,
    marginDb: isNum(o.marginDb) ? o.marginDb : DEFAULTS.marginDb,
    headEnd: o.headEnd,
    network: o.network || null,
    maxSnapM: isNum(o.maxSnapM) ? o.maxSnapM : DEFAULTS.maxSnapM,
    joinToleranceM: isNum(o.joinToleranceM) ? o.joinToleranceM : DEFAULTS.joinToleranceM,
    pon: Object.assign({}, DEFAULTS.pon, o.pon || {}),
    active: Object.assign({}, DEFAULTS.active, o.active || {}),
    ladder: Array.isArray(o.ladder) && o.ladder.length ? o.ladder : DEFAULTS.ladder,
    ladderSupplied: Array.isArray(o.ladder) && o.ladder.length > 0,
    overlengthPct: isNum(o.overlengthPct) ? o.overlengthPct : DEFAULTS.overlengthPct,
    costs: costModel(o.costs),
    kmeansIterations: DEFAULTS.kmeansIterations,
    includeAllPlants: !!o.includeAllPlants
  };
}

// ---------------------------------------------------------------- geometry

function distanceM(a, b, factor) {
  return geo.distanceM(a, b) * factor;
}

/**
 * Minimum spanning tree over `nodes` (Kruskal, sorted by length then by id).
 *
 * Kruskal rather than Prim because the sort makes the tie-break explicit: two equal-length edges are
 * ordered by node id, so the tree does not depend on the order the points arrived in. A synthesised
 * design that changes when the CSV is re-sorted is not a design.
 */
function minimumSpanningTree(nodes, factor) {
  const pairs = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      pairs.push({ a: nodes[i].id, b: nodes[j].id, lengthM: distanceM(nodes[i], nodes[j], factor) });
    }
  }
  pairs.sort(function (x, y) {
    if (Math.abs(x.lengthM - y.lengthM) > 1e-6) return x.lengthM - y.lengthM;
    return cmpIds(x.a + x.b, y.a + y.b);
  });

  const parent = new Map();
  function find(id) {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  }
  for (const node of nodes) parent.set(node.id, node.id);

  const edges = [];
  for (const pair of pairs) {
    const ra = find(pair.a);
    const rb = find(pair.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    edges.push(pair);
    if (edges.length === nodes.length - 1) break;
  }
  return edges;
}

function adjacencyOf(edges) {
  const adj = new Map();
  for (const edge of edges) {
    if (!adj.has(edge.a)) adj.set(edge.a, []);
    if (!adj.has(edge.b)) adj.set(edge.b, []);
    adj.get(edge.a).push(edge.b);
    adj.get(edge.b).push(edge.a);
  }
  return adj;
}

/** Breadth-first parents from the root, so each edge has a clear "away from the head-end" side. */
function orient(edges, rootId) {
  const adj = adjacencyOf(edges);
  const parent = new Map();
  const order = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of (adj.get(id) || []).slice().sort(cmpIds)) {
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, id);
      queue.push(next);
    }
  }
  return { parent: parent, order: order };
}

function orientEdge(edge, parent) {
  if (parent.get(edge.a) === edge.b) return { child: edge.a, parent: edge.b };
  if (parent.get(edge.b) === edge.a) return { child: edge.b, parent: edge.a };
  throw new Error('edge ' + edge.a + '-' + edge.b + ' is not part of the tree');
}

/** Counts of a weight per node, rolled up the tree from the leaves. */
function subtreeWeights(edges, rootId, nodeIds, weightOf) {
  const oriented = orient(edges, rootId);
  const totals = new Map();
  for (const id of nodeIds) totals.set(id, weightOf(id));
  for (let i = oriented.order.length - 1; i >= 0; i--) {
    const id = oriented.order[i];
    const up = oriented.parent.get(id);
    if (up) totals.set(up, (totals.get(up) || 0) + (totals.get(id) || 0));
  }
  return { totals: totals, parent: oriented.parent };
}

// ---------------------------------------------------------------- cables

/**
 * The SMALLEST cable in the ladder that carries `requiredFibres`.
 *
 * It used to return the first entry that fit, and the ladder is ordered richest-first, so every
 * two-fibre branch was designed on 144-fibre cable: a bill of materials wrong by a factor of seventy
 * and a design nobody could pull. Order in the ladder is a preference, not a match.
 */
function cableFor(requiredFibres, ladder, registry) {
  let best = null;
  let largest = null;
  for (const model of ladder) {
    if (!registry.has('cable', model)) continue;
    const cable = registry.get('cable', model);
    if (!largest || cable.fiberCount > largest.fiberCount) largest = cable;
    if (cable.fiberCount < requiredFibres) continue;
    if (!best || cable.fiberCount < best.fiberCount ||
        (cable.fiberCount === best.fiberCount && cmpIds(cable.model, best.model) < 0)) {
      best = cable;
    }
  }
  if (best) return best;
  if (!largest) throw new Error('the cable ladder names no cable this catalogue has: ' + ladder.join(', '));
  return largest;
}

/** Distribution cable: a drop cable for one or two fibres, the ladder above that. */
function cableForDistribution(requiredFibres, ladder, registry) {
  if (requiredFibres <= 1 && registry.has('cable', 'g657a2-drop-1')) return registry.get('cable', 'g657a2-drop-1');
  if (requiredFibres <= 2 && registry.has('cable', 'g657a2-drop-2')) return registry.get('cable', 'g657a2-drop-2');
  return cableFor(Math.max(12, requiredFibres), ladder, registry);
}

/** Above this, a span is a cable run, not a drop - and drop cable is the wrong product for it. */
const DROP_CABLE_MAX_M = 300;

/**
 * Is this cable a drop? The catalogue says so, on the one field a drop is bought for.
 *
 * `use` is catalogue metadata (`parts/cable/*.json`, validated by `parts.js`), and it is the only
 * place the difference between a drop and a feeder is written down. A model check would do for the
 * two drop models in the catalogue today and break silently at the third.
 */
function isDropCable(cable) {
  return Array.isArray(cable.use) && cable.use.indexOf('drop') !== -1;
}

/**
 * The cable for a span that carries `fibres` over `lengthM`.
 *
 * Two fibres over 1.2 km is not a drop: it is a two-fibre cable run, and designing it as drop cable
 * produces a bill of materials nobody can buy (drop cable is not pulled between buildings or between
 * two data centres). Short two-fibre runs keep the drop cable, everything else goes to the ladder.
 */
function cableForSpan(fibres, lengthM, ladder, registry) {
  if (lengthM <= DROP_CABLE_MAX_M && fibres <= 2) {
    return cableForDistribution(fibres, ladder, registry);
  }
  return cableFor(Math.max(12, fibres), ladder, registry);
}

/**
 * The strands a span uses: the run `1..count`, capped at the span's capacity in fibres.
 *
 * The cap is the capacity of the **whole span**, not of one cable. `bundles` is how many whole cables
 * run the route (SPEC §5) and `spanFibreCapacity` already counts every cable's fibres (SPEC §6: "18
 * strands in use on a 2 x 12 span is three-quarters full"), so capping at one cable's `fiberCount`
 * made a 37-ONT active-tree span - seven 12-fibre cables, 84 fibres of capacity, 74 live - list
 * **12** strands: the ledger read "12 of 84 used, 72 spare" and the splice sheet scheduled 24 rows
 * for 74 live fibres, so 62 fibres a crew has to splice were absent from the sheet (gh#96).
 */
function strandList(count, capacityFibres) {
  const n = Math.min(count, capacityFibres);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------- PON clustering

/**
 * Deterministic k-means with a capacity and a radius, or k grows.
 *
 * A 1:8 splitter serving nine houses is not a PON, it is two PONs, and a cluster whose farthest
 * member is 900 m away is a drop that will not budget. Rather than letting k-means produce either,
 * the cluster count rises until both constraints hold - at the limit every point is its own splitter,
 * which is the honest answer for a demand spread over a valley.
 *
 * Distances here are straight-line on purpose even when the runs are street-routed: grouping is a
 * coverage question, and the lengths that end up in the budget are measured by the router.
 */
function clusterPoints(points, headEnd, ratio, maxDropM, factor, maxIterations) {
  let k = Math.max(1, Math.ceil(points.length / ratio));
  for (let attempt = 0; attempt <= points.length; attempt++) {
    const clusters = kmeans(points, headEnd, k, factor, maxIterations);
    const bad = clusters.filter(function (c) {
      return c.members.length > ratio || c.maxDistM > maxDropM;
    });
    if (!bad.length || k >= points.length) return { clusters: clusters, k: k };
    k = Math.min(points.length, k + 1);
  }
  return { clusters: kmeans(points, headEnd, points.length, factor, maxIterations), k: points.length };
}

function kmeans(points, headEnd, k, factor, maxIterations) {
  const centres = [];
  let first = points[0];
  for (const point of points) {
    if (distanceM(headEnd, point, factor) < distanceM(headEnd, first, factor)) first = point;
  }
  centres.push({ lat: first.lat, lon: first.lon });

  while (centres.length < Math.min(k, points.length)) {
    let best = null;
    let bestDistance = -1;
    for (const point of points) {
      let nearest = Infinity;
      for (const centre of centres) nearest = Math.min(nearest, distanceM(point, centre, factor));
      if (nearest > bestDistance + 1e-6 ||
          (Math.abs(nearest - bestDistance) <= 1e-6 && best && cmpIds(point.id, best.id) < 0)) {
        best = point;
        bestDistance = nearest;
      }
    }
    centres.push({ lat: best.lat, lon: best.lon });
  }

  let assignment = new Array(points.length).fill(-1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const next = new Array(points.length).fill(-1);
    const counts = new Array(centres.length).fill(0);
    for (let i = 0; i < points.length; i++) {
      let chosen = -1;
      let bestDistance = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = distanceM(points[i], centres[c], factor);
        if (d < bestDistance - 1e-6) { bestDistance = d; chosen = c; }
      }
      next[i] = chosen;
      counts[chosen] += 1;
    }
    const cap = Math.ceil(points.length / Math.max(1, centres.length));
    const overflow = [];
    for (let i = 0; i < points.length; i++) {
      if (counts[next[i]] <= cap) continue;
      overflow.push(i);
    }
    overflow.sort(function (x, y) {
      const dx = distanceM(points[x], centres[next[x]], factor);
      const dy = distanceM(points[y], centres[next[y]], factor);
      if (Math.abs(dx - dy) > 1e-6) return dy - dx;
      return cmpIds(points[x].id, points[y].id);
    });
    for (const i of overflow) {
      let chosen = next[i];
      let bestDistance = Infinity;
      for (let c = 0; c < centres.length; c++) {
        if (c === chosen || counts[c] >= cap) continue;
        const d = distanceM(points[i], centres[c], factor);
        if (d < bestDistance - 1e-6) { bestDistance = d; chosen = c; }
      }
      if (chosen !== next[i]) {
        counts[next[i]] -= 1;
        counts[chosen] += 1;
        next[i] = chosen;
      }
    }

    const stable = next.every(function (value, i) { return value === assignment[i]; });
    assignment = next;
    if (stable && iteration > 0) break;

    for (let c = 0; c < centres.length; c++) {
      const members = points.filter(function (_, i) { return assignment[i] === c; });
      if (!members.length) continue;
      let best = members[0];
      let bestCost = Infinity;
      for (const candidate of members) {
        let cost = 0;
        for (const member of members) cost += distanceM(candidate, member, factor);
        if (cost < bestCost - 1e-6) { bestCost = cost; best = candidate; }
      }
      centres[c] = { lat: best.lat, lon: best.lon };
    }
  }

  return centres.map(function (centre, c) {
    const members = points.filter(function (_, i) { return assignment[i] === c; });
    let maxDistM = 0;
    for (const member of members) maxDistM = Math.max(maxDistM, distanceM(centre, member, factor));
    return { centre: centre, members: members, maxDistM: maxDistM };
  }).filter(function (c) { return c.members.length > 0; });
}

// ---------------------------------------------------------------- routing providers

/**
 * The straight-line provider: an MST over the root and the points.
 *
 * Every point is a terminal, edges carry the number of terminals below them, and each span's geometry
 * is the straight line between its ends.
 */
function euclidTree(rootPoint, points, factor) {
  const nodes = [{ id: 'root', lat: rootPoint.lat, lon: rootPoint.lon }].concat(points.map(function (p) {
    return { id: p.id, lat: p.lat, lon: p.lon };
  }));
  const mstEdges = minimumSpanningTree(nodes, factor);
  const weights = subtreeWeights(mstEdges, 'root', nodes.map(function (n) { return n.id; }), function (id) {
    return id === 'root' ? 0 : 1;
  });
  const oriented = orient(mstEdges, 'root');
  const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));

  const degree = new Map();
  for (const edge of mstEdges) {
    degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
  }

  const treeNodes = nodes.map(function (node) {
    return {
      key: node.id,
      lat: node.lat,
      lon: node.lon,
      terminals: node.id === 'root' ? 0 : 1,
      degree: degree.get(node.id) || 0,
      attachTerminals: node.id === 'root' ? [] : [node.id],
      isRoot: node.id === 'root'
    };
  });

  const edges = mstEdges.map(function (edge) {
    const side = orientEdge(edge, oriented.parent);
    const a = byId.get(side.parent);
    const b = byId.get(side.child);
    return {
      from: side.parent,
      to: side.child,
      // A cluster's medoid sits exactly on the splitter site, so its tree edge measures 0 m - which is
      // not a span this model accepts. One metre is the shortest drop that can physically exist.
      lengthM: Math.max(1, round(edge.lengthM, 1)),
      route: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      terminals: weights.totals.get(side.child) || 0
    };
  });

  const spurs = new Map();
  for (const point of points) spurs.set(point.id, 0);

  return { rootId: 'root', nodes: treeNodes, edges: edges, spurs: spurs, unresolved: [], totalM: round(edges.reduce(function (n, e) { return n + e.lengthM; }, 0), 2) };
}

/**
 * Charge the head end's own distance to the street to the cable that leaves it.
 *
 * `street.snap` measures the gap from a site to the point where it joins the network, and for a
 * customer that gap is bought as the drop span. The head end is not in the demand list, so nothing
 * bought its gap: measured on a PoP 66.7 m behind the pavement, every span out of `n-headend` was
 * billed 66.7 m less than the route drawn between the head-end node and the same street vertex - the
 * drawing said 101 m and the bill of materials said 35 m for the same cable. `engine/link.js` charges
 * both sites' drops for exactly this reason, and the street rule is the same one: a site is not on the
 * centreline, and the gap is a real length.
 *
 * Every edge leaving the root is its own cable (a bundle of them when the fibres need it) and each one
 * crosses the gap, so each one is longer by the whole gap; the head-end coordinate becomes the first
 * point of its route. Mutates the tree `street.routedTree` just returned, which is a fresh object.
 */
function attachHeadEnd(routed, root, rootSnap) {
  if (!(rootSnap.spurM > 0)) return;
  let rootEdges = 0;
  for (const edge of routed.edges) {
    if (edge.from !== routed.rootId) continue;
    edge.lengthM = round(edge.lengthM + rootSnap.spurM, 2);
    edge.route = [{ lat: root.lat, lon: root.lon }].concat(edge.route);
    rootEdges++;
  }
  routed.totalM = round(routed.totalM + rootSnap.spurM * rootEdges, 2);
}

/**
 * The street provider: snap every terminal, then take the union of shortest paths from the root.
 *
 * Anything the graph cannot reach comes back in `unresolved` rather than being connected by a straight
 * line: an address two kilometres from the nearest street is a design problem, and the caller turns it
 * into an infeasible candidate with that reason.
 *
 * `rootIsHeadEnd` charges the root's own gap to the cable that leaves it. A customer's gap is emitted
 * as a drop span from `spurs`; the head end is the one terminal that is not in the demand list, so
 * nothing used to charge its gap and the first span was billed shorter than the route drawn between
 * the head-end node and the street. A splitter site is *not* a head end: it is a house in the demand
 * list, and its drop span already carries its gap.
 */
function streetTree(graph, root, points, opts, rootIsHeadEnd) {
  const rootSnap = street.snap(graph, root, { maxSnapM: opts.maxSnapM });
  if (!rootSnap) throw new Error('the head-end is more than ' + opts.maxSnapM + ' m from the street network');

  const terminals = [];
  const unresolved = [];
  const spurs = new Map();
  for (const point of points) {
    const snapped = street.snap(graph, point, { maxSnapM: opts.maxSnapM });
    if (!snapped) { unresolved.push(point.id); continue; }
    terminals.push({ id: point.id, nodeId: snapped.nodeId, spurM: snapped.spurM });
    spurs.set(point.id, snapped.spurM);
  }

  const routed = street.routedTree(graph, rootSnap.nodeId, terminals, {});
  if (rootIsHeadEnd) attachHeadEnd(routed, root, rootSnap);
  const treeNodes = routed.nodes.map(function (node) {
    return {
      key: node.key,
      lat: node.lat,
      lon: node.lon,
      terminals: node.terminals,
      degree: node.degree,
      attachTerminals: node.attachTerminals,
      isRoot: node.isRoot
    };
  });

  return {
    rootId: routed.rootId,
    rootLat: rootSnap.at.lat,
    rootLon: rootSnap.at.lon,
    rootSpurM: rootSnap.spurM,
    nodes: treeNodes,
    edges: routed.edges,
    spurs: spurs,
    unresolved: unresolved.concat(routed.unresolved),
    totalM: routed.totalM
  };
}

// ---------------------------------------------------------------- key names

function clusterCentre(members) {
  // The site is a real property (the medoid the cluster was built around), so it has real coordinates
  // and, when routing, a real snap onto the street.
  const first = members[0];
  return { lat: first.lat, lon: first.lon };
}

function opticSpeed(model, registry) {
  return registry.has('transceiver', model) ? registry.get('transceiver', model).speedMbps : null;
}

function opticLabel(model, registry) {
  if (!registry.has('transceiver', model)) return model;
  const optic = registry.get('transceiver', model);
  return (optic.speedMbps >= 1000 ? (optic.speedMbps / 1000) + ' Gb/s' : optic.speedMbps + ' Mb/s') +
    ' ' + optic.model.replace(/^sfp(28|\+)?-/, '').toUpperCase();
}

function closureModelFor(degree) {
  return degree <= 8 ? 'nap-8' : degree <= 16 ? 'nap-16' : 'mufa-inline-24';
}

// ---------------------------------------------------------------- plant builders

/** A customer-facing tree: active Ethernet, or a PON's distribution. */
function emitTerminalTree(plant, tree, cfg, registry) {
  const idOf = new Map();
  idOf.set(tree.rootId, cfg.rootPlantId);

  // A node sitting on the root's own coordinates is not a span away from it. A splitter site is a
  // house (the cluster's medoid), so the tree rooted there owns the house it stands on, and the MST
  // edge between the two measures 0 m. Emitted, the 1 m span floor turned that edge into a
  // distribution span carrying the whole cluster's fibres, and the BOM bought a 24-fibre drum for the
  // inside of one closure (gh#39). Contracted, the house hangs off the root like any other terminal
  // and is served by its own drop - which is what `street.routedTree` already does with a terminal
  // that snaps onto the root node.
  const root = tree.nodes.filter(function (n) { return n.isRoot; })[0];
  const onRoot = new Set();
  for (const node of tree.nodes) {
    if (!node.isRoot && root && node.lat === root.lat && node.lon === root.lon) onRoot.add(node.key);
  }
  // The feeder site the tree hangs from, for every node - a contracted node and a leaf both name it.
  function plantIdOf(key) {
    return onRoot.has(key) ? cfg.rootPlantId : idOf.get(key);
  }

  for (const node of tree.nodes) {
    if (node.isRoot) continue;
    if (onRoot.has(node.key)) { idOf.set(node.key, cfg.rootPlantId); continue; }
    if (node.degree >= 2 || node.attachTerminals.length) {
      const id = cfg.prefix + 'c-' + node.key;
      plant.nodes.push({
        id: id, type: 'closure', model: closureModelFor(node.degree),
        name: (node.attachTerminals.length ? node.attachTerminals[0] + ' ' : '') + 'closure ',
        lat: node.lat, lon: node.lon
      });
      idOf.set(node.key, id);
    } else {
      idOf.set(node.key, cfg.rootPlantId);
    }
  }

  for (const node of tree.nodes) {
    for (const terminalId of node.attachTerminals) {
      const point = cfg.pointById.get(terminalId);
      if (!point) continue;
      const ontId = cfg.prefix + 'ont-' + terminalId;
      plant.nodes.push({
        id: ontId, type: 'ont', model: cfg.terminalModel,
        name: point.label, lat: point.lat, lon: point.lon
      });
      const spur = tree.spurs.get(terminalId) || 0;
      const dropM = Math.max(1, round(spur, 1));
      plant.spans.push({
        id: cfg.prefix + 'drop-' + terminalId,
        from: idOf.get(node.key), to: ontId,
        // The drop is a span like any other, so it obeys the span rule: the builder's `terminalCable`
        // is right for a spur and wrong for a rural 400 m gap, where it bought 1-fibre drop cable on a
        // run nobody pulls one. `cableForSpan` is the one place the limit lives.
        cable: cableForSpan(cfg.terminalFibres, dropM, cfg.ladder, registry).model,
        lengthM: dropM,
        strands: cfg.terminalFibres === 1 ? [1] : [1, 2],
        purpose: cfg.dropPurpose,
        feedsOnts: 1,
        route: spur > 0 ? [{ lat: node.lat, lon: node.lon }, { lat: point.lat, lon: point.lon }] : null
      });
    }
  }

  for (const edge of tree.edges) {
    const from = plantIdOf(edge.from);
    const to = plantIdOf(edge.to);
    // Both ends are the same place: the edge contracted onto the root is not a span, and charging it
    // is what bought the 24-fibre drum (gh#39).
    if (from === to) continue;
    const fibres = Math.max(cfg.minFibres, edge.terminals * cfg.fibresPerTerminal);
    const cable = cableForSpan(fibres, edge.lengthM, cfg.ladder, registry);
    const bundles = Math.max(1, Math.ceil(fibres / cable.fiberCount));
    plant.spans.push({
      id: cfg.prefix + 's-' + edge.from + '-' + edge.to,
      from: from, to: to,
      cable: cable.model,
      lengthM: edge.lengthM,
      // The span's capacity is every cable in the bundle; listing one cable's run hid the fibres
      // the second cable carries from the ledger and from the splice sheet.
      strands: strandList(fibres, cable.fiberCount * bundles),
      bundles: bundles,
      purpose: cfg.purpose,
      feedsOnts: edge.terminals,
      route: edge.route
    });
  }
}

/** The PON feeder: a tree to the splitter sites, each splitter on a short tail off its own closure. */
function emitFeederTree(plant, tree, cfg, registry) {
  const idOf = new Map();
  const closureOf = new Map();
  idOf.set(tree.rootId, cfg.rootPlantId);

  for (const node of tree.nodes) {
    if (node.isRoot) continue;
    const closureId = cfg.prefix + 'fc-' + node.key;
    plant.nodes.push({
      id: closureId, type: 'closure', model: closureModelFor(node.degree),
      name: 'Feeder closure', lat: node.lat, lon: node.lon
    });
    closureOf.set(node.key, closureId);
    idOf.set(node.key, closureId);
    if (node.attachTerminals.length) {
      const splitterId = cfg.prefix + 'spl-' + node.key;
      plant.nodes.push({
        id: splitterId, type: 'splitter', model: cfg.splitterModel,
        name: cfg.splitterName, lat: node.lat, lon: node.lon
      });
      plant.spans.push({
        id: cfg.prefix + 'tail-' + node.key, from: closureId, to: splitterId,
        cable: 'g657a2-drop-1', lengthM: 1, strands: [1], purpose: 'splitter-tail', feedsOnts: 0
      });
      cfg.splitterPlantId.set(node.attachTerminals[0], splitterId);
    }
  }

  for (const edge of tree.edges) {
    const fibres = Math.max(12, edge.terminals);
    const cable = cableFor(fibres, cfg.ladder, registry);
    const bundles = Math.max(1, Math.ceil(fibres / cable.fiberCount));
    plant.spans.push({
      id: cfg.prefix + 'f-' + edge.from + '-' + edge.to,
      from: idOf.get(edge.from), to: idOf.get(edge.to),
      cable: cable.model,
      lengthM: edge.lengthM,
      // Capacity is every cable in the bundle, the same rule as the distribution tree above.
      strands: strandList(fibres, cable.fiberCount * bundles),
      bundles: bundles,
      purpose: 'feeder',
      feedsSplitters: edge.terminals,
      route: edge.route
    });
  }
}

function headEndNode(opts, technology, opticModel) {
  const pon = technology === 'pon';
  return {
    id: 'n-headend',
    type: pon ? 'olt' : 'headend',
    model: pon ? opts.pon.olt : (opticModel || opts.active.headEndOptic),
    name: opts.headEnd.name || (pon ? 'OLT' : 'Head-end'),
    lat: opts.headEnd.lat,
    lon: opts.headEnd.lon
  };
}

function buildActiveTree(demand, opts, registry, optic, graph) {
  const active = Object.assign({}, opts.active, optic);
  const plant = { name: 'Active tree', nodes: [headEndNode(opts, 'active', active.headEndOptic)], spans: [] };
  const tree = graph
    ? streetTree(graph, opts.headEnd, demand.points, opts, true)
    : euclidTree(opts.headEnd, demand.points, opts.routeFactor);

  emitTerminalTree(plant, tree, {
    rootPlantId: 'n-headend',
    prefix: '',
    pointById: new Map(demand.points.map(function (p) { return [p.id, p]; })),
    terminalModel: active.cpeOptic,
    terminalCable: 'g657a2-drop-2',
    terminalFibres: 2,
    fibresPerTerminal: 2,
    minFibres: 2,
    distribution: false,
    purpose: 'tree',
    dropPurpose: 'drop',
    ladder: opts.ladder
  }, registry);

  return finalise(plant, opts, registry, 'active-tree', {
    label: 'Active Ethernet over a shared cable tree, ' + opticLabel(active.cpeOptic, registry),
    settings: { optic: active.cpeOptic, headEndOptic: active.headEndOptic, speedMbps: opticSpeed(active.cpeOptic, registry) },
    unresolved: tree.unresolved
  });
}

function buildActiveHomeRun(demand, opts, registry, optic, graph) {
  const active = Object.assign({}, opts.active, optic);
  const plant = { name: 'Active home-run', nodes: [headEndNode(opts, 'active', active.headEndOptic)], spans: [] };
  const unresolved = [];

  if (graph) {
    const rootSnap = street.snap(graph, opts.headEnd, { maxSnapM: opts.maxSnapM });
    if (!rootSnap) throw new Error('the head-end is more than ' + opts.maxSnapM + ' m from the street network');
    const spt = street.dijkstra(graph, rootSnap.nodeId);
    demand.points.forEach(function (point, i) {
      const snapped = street.snap(graph, point, { maxSnapM: opts.maxSnapM });
      if (!snapped) { unresolved.push(point.id); return; }
      const path = street.routePath(graph, rootSnap.nodeId, snapped.nodeId, spt);
      if (!path) { unresolved.push(point.id); return; }
      plant.nodes.push({
        id: 'n-ont-' + point.id, type: 'ont', model: active.cpeOptic,
        name: point.label, lat: point.lat, lon: point.lon
      });
      // Every customer on this topology has their own cable out of the exchange, so each one crosses
      // the head end's own gap to the street - it is the one site whose gap no drop span carries.
      const rootGapM = rootSnap.spurM;
      const lengthM = Math.max(1, round(path.lengthM + rootGapM + snapped.spurM, 1));
      const route = (rootGapM > 0
        ? [{ lat: opts.headEnd.lat, lon: opts.headEnd.lon }]
        : []).concat(path.route, [{ lat: point.lat, lon: point.lon }]);
      plant.spans.push({
        id: 's-' + (i + 1), from: 'n-headend', to: 'n-ont-' + point.id,
        // The drop/ladder rule is `cableForSpan`'s. Restating it here as a magic 300 and a hard-coded
        // model ignored the caller's ladder, so a design could be billed for a cable it excluded.
        cable: cableForSpan(2, lengthM, opts.ladder, registry).model,
        lengthM: lengthM, strands: [1, 2], purpose: 'home-run', feedsOnts: 1,
        route: route
      });
    });
  } else {
    demand.points.forEach(function (point, i) {
      const lengthM = Math.max(1, round(distanceM(opts.headEnd, point, opts.routeFactor), 1));
      plant.nodes.push({
        id: 'n-ont-' + point.id, type: 'ont', model: active.cpeOptic,
        name: point.label, lat: point.lat, lon: point.lon
      });
      plant.spans.push({
        id: 's-' + (i + 1), from: 'n-headend', to: 'n-ont-' + point.id,
        cable: cableForSpan(2, lengthM, opts.ladder, registry).model,
        lengthM: lengthM, strands: [1, 2], purpose: 'home-run', feedsOnts: 1,
        route: [{ lat: opts.headEnd.lat, lon: opts.headEnd.lon }, { lat: point.lat, lon: point.lon }]
      });
    });
  }

  return finalise(plant, opts, registry, 'active-home-run', {
    label: 'Active Ethernet, one cable per customer, ' + opticLabel(active.cpeOptic, registry),
    settings: { optic: active.cpeOptic, headEndOptic: active.headEndOptic, speedMbps: opticSpeed(active.cpeOptic, registry) },
    unresolved: unresolved
  });
}

function buildPon(demand, opts, registry, ratio, graph) {
  const splitterModel = 'plc-1x' + ratio + '-sca';
  if (!registry.has('splitter', splitterModel)) return null;

  const factor = opts.routeFactor;
  const clustered = clusterPoints(demand.points, opts.headEnd, ratio, opts.pon.maxDropM, factor, opts.kmeansIterations);
  const clusters = clustered.clusters;

  const plant = { name: 'PON 1:' + ratio, nodes: [headEndNode(opts, 'pon')], spans: [] };
  const splitterPlantId = new Map();
  const unresolved = [];
  const pointById = new Map(demand.points.map(function (p) { return [p.id, p]; }));
  const sitePoints = clusters.map(function (cluster, i) {
    const centre = cluster.centre;
    return { id: 'site-' + (i + 1), label: 'Splitter site ' + (i + 1), lat: centre.lat, lon: centre.lon };
  });

  // Feeder: head-end to a closure at every splitter site, each splitter on a 1 m tail.
  const feeder = graph
    ? streetTree(graph, opts.headEnd, sitePoints, opts, true)
    : euclidTree(opts.headEnd, sitePoints, factor);
  // A site that cannot be reached means the *houses it serves* cannot be served, so report those:
  // telling a planner "site-2 is unresolved" when they typed forty addresses names the wrong thing.
  for (const id of feeder.unresolved) {
    const index = sitePoints.findIndex(function (site) { return site.id === id; });
    if (index >= 0) clusters[index].members.forEach(function (member) { unresolved.push(member.id); });
    else unresolved.push(id);
  }

  emitFeederTree(plant, feeder, {
    rootPlantId: 'n-headend',
    prefix: '',
    splitterModel: splitterModel,
    splitterName: 'Splitter 1:' + ratio,
    splitterPlantId: splitterPlantId,
    ladder: opts.ladder
  }, registry);

  // Distribution: one tree per cluster, rooted at its splitter.
  clusters.forEach(function (cluster, i) {
    const sitePoint = sitePoints[i];
    const members = cluster.members;
    if (!members.length) return;

    let rootPlantId = splitterPlantId.get(sitePoint.id);
    if (!rootPlantId) {
      // The site did not resolve (no street within reach): name the houses it was meant to serve.
      members.forEach(function (member) { unresolved.push(member.id); });
      return;
    }

    const tree = graph
      ? streetTree(graph, sitePoint, members, opts)
      : euclidTree(sitePoint, members, factor);
    unresolved.push.apply(unresolved, tree.unresolved);

    emitTerminalTree(plant, tree, {
      rootPlantId: rootPlantId,
      prefix: 'd' + (i + 1) + '-',
      pointById: pointById,
      terminalModel: opts.pon.ont,
      terminalCable: 'g657a2-drop-1',
      terminalFibres: 1,
      fibresPerTerminal: 1,
      minFibres: 1,
      distribution: true,
      purpose: 'distribution',
      dropPurpose: 'drop',
      ladder: opts.ladder
    }, registry);
  });

  return finalise(plant, opts, registry, 'pon', {
    label: 'PON 1:' + ratio + ' with ' + clusters.length + ' splitter site(s)',
    settings: { ratio: ratio, splitters: clusters.length, maxDropM: opts.pon.maxDropM },
    unresolved: unresolved
  });
}

// ---------------------------------------------------------------- evaluation

function bomOf(plant, registry, opts) {
  const byModel = new Map();
  let fibreMetres = 0;
  for (const span of plant.spans) {
    const cable = registry.get('cable', span.cable);
    const bundles = span.bundles || 1;
    // Cable is priced roughly with its fibre count, so the objective is fibre-metres, not metres: a
    // 24-fibre trunk is not the same purchase as a 12-fibre distribution run of the same length.
    fibreMetres += span.lengthM * bundles * cable.fiberCount;
    const prev = byModel.get(cable.model) || { model: cable.model, label: cable.label, fiberCount: cable.fiberCount, routeM: 0, fibres: 0, drumM: cable.drumM };
    prev.routeM = round(prev.routeM + span.lengthM * bundles, 1);
    prev.fibres += span.strands ? span.strands.length : 0;
    byModel.set(cable.model, prev);
  }
  const lines = Array.from(byModel.values()).map(function (row) {
    // The drum is the cable's own: 1-fibre drop ships on 1 km, trunk on 2 km. A hardcoded 2 km here
    // bought 915 m of drop as 2000 m - a drum of a product that cable is not sold on - and charged a
    // 2500 m run as 4000 m. Rounding stays once per model, on the aggregate.
    const calc = lengthModule.cableToBuy({ routeM: row.routeM, overlengthPct: opts.overlengthPct, splices: 0, closures: 0, drumM: row.drumM });
    return {
      model: row.model,
      label: row.label,
      fiberCount: row.fiberCount,
      routeM: row.routeM,
      designM: calc.designM,
      drumM: calc.drumM,
      drums: calc.drums,
      purchaseM: calc.purchaseM,
      spareM: calc.spareM
    };
  }).sort(function (a, b) { return cmpIds(a.model, b.model); });

  const cableM = round(lines.reduce(function (n, l) { return n + l.routeM; }, 0), 1);
  const designM = round(lines.reduce(function (n, l) { return n + l.designM; }, 0), 1);
  return { lines: lines, cableM: cableM, designM: designM, fibreMetres: round(fibreMetres, 1) };
}

/**
 * Spans the built plant puts on drop cable outside the drop class, one sentence per shape.
 *
 * `cableForSpan` already sends a span to the ladder above 300 m or above two fibres; when the ladder
 * has nothing there, `cableFor` answers with its largest rung, and when that rung is a drop cable the
 * span is built anyway. `link.cableForFibres` refuses the same shape for a circuit. Here the span
 * exists in the plant, so the refusal reads it back rather than guessing: the sentence names the
 * span, the length or fibre count that left the class, and the rung the caller has to add.
 *
 * One sentence per shape, not per span: a 40-house feeder is a dozen of them, and a reason list that
 * repeats one failure buries the other reasons (the same rule `evaluate` applies to ONT failures).
 */
function dropClassRefusals(plant, registry) {
  const seen = new Set();
  const out = [];
  for (const span of plant.spans) {
    const cable = registry.get('cable', span.cable);
    if (!isDropCable(cable)) continue;
    const bundles = span.bundles || 1;
    const fibres = span.strands ? span.strands.length : 0;
    const addRung = 'add a distribution cable at 12 fibres or more to the ladder';
    if (bundles > 1) {
      const key = 'bundle:' + cable.model + ':' + fibres;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push('the cable ladder names no cable that carries ' + fibres + ' fibres: ' + cable.model +
        ' is a ' + cable.fiberCount + '-fibre drop cable, and a span is not built by bundling drop ' +
        'cable - ' + span.id + ' needs ' + fibres + ' fibres over ' + span.lengthM + ' m; ' + addRung);
    } else if (span.lengthM > DROP_CABLE_MAX_M) {
      const key = 'long:' + cable.model;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push('the cable ladder names no cable that carries ' + span.lengthM + ' m: ' + cable.model +
        ' is a ' + cable.fiberCount + '-fibre drop cable and drop cable is the last leg, at most ' +
        DROP_CABLE_MAX_M + ' m - ' + span.id + ' is ' + span.lengthM + ' m; ' + addRung);
    }
  }
  return out;
}

function evaluate(plant, opts, registry, meta) {
  const structural = network.validate(plant, registry);
  const budgets = network.allOntBudgets(plant, registry, { marginDb: opts.marginDb, direction: 'down' });
  // The other half of every link over this ODN. A PON is two links over one loss - the ONT launches
  // into the OLT receiver at 1310 nm, 0.35 dB/km, the more lossy wavelength - and the upstream
  // verdict was never asked for here, so a candidate whose every ONT was `ok` downstream and `fail`
  // upstream was ranked, costed and offered as the best design (#185). It is reported, not gated:
  // no PON class floor is modelled (only the ceiling), so making it part of `feasible` would empty
  // auto-design for an ordinary short-feed estate - a decision #111/#185 still owes, not one a report
  // makes in passing.
  const upstream = network.allOntBudgets(plant, registry, { marginDb: opts.marginDb, direction: 'up' });
  const upstreamFailures = upstream.filter(function (b) { return b.result && b.result.verdict === 'fail'; });

  const failures = budgets.filter(function (b) { return b.error || (b.result && b.result.verdict === 'fail'); });
  const headrooms = budgets.filter(function (b) { return b.result && isNum(b.result.headroomDb); })
    .map(function (b) { return b.result.headroomDb; });

  // The launch-window band (#111). Overload is judged at the floor of the OLT's window, so these ONTs
  // pass - and they pass only while every line card that lands in the chassis is a cold one. The
  // verdict stays where SPEC §4 puts it; the report must not stay silent about the band, and a
  // synthesised plan is the last place it is cheap to say so.
  const hotLaunch = budgets.filter(function (b) { return b.result && b.result.launchWindowPad; });

  // The other verdict that is not a failure and not a clean pass. `marginal` exists because a design
  // inside 2 dB of its margin, or with under 1 dB of class budget left, is a decision rather than a
  // sign-off (`docs/SPEC.md` §4) - and the report counted neither it nor its number, so a synthesised
  // plan whose ONTs all landed in the band was offered as `feasible` and ranked as the best design with
  // nothing said. `marginalReasonFor` in `budget.js` supplies the sentence; this counts the ONTs and
  // reports the tightest, once for the plant, the way `launchWindowNote` does for the band.
  const marginalOnts = budgets.filter(function (b) { return b.result && b.result.verdict === 'marginal'; });

  const bom = bomOf(plant, registry, opts);
  const closures = plant.nodes.filter(function (n) { return n.type === 'closure'; }).length;
  const splitters = plant.nodes.filter(function (n) { return n.type === 'splitter'; }).length;
  const onts = plant.nodes.filter(function (n) { return n.type === 'ont'; }).length;
  const splices = plant.nodes.reduce(function (n, node) {
    if (node.type === 'closure') return n + 1;
    if (node.type === 'splitter') return n + 1;
    return n;
  }, 0);

  const reasons = [];
  const unresolved = meta.unresolved || [];
  if (unresolved.length) {
    reasons.push(unresolved.length + ' address(es) are not on the street network or not reachable along it: ' +
      unresolved.slice(0, 5).join(', ') + (unresolved.length > 5 ? ', ...' : ''));
  }
  if (!structural.ok) Array.prototype.push.apply(reasons, structural.errors);
  // The plant may be built, budgeted and still wrong in a way no validator clause covers: a span
  // longer than a drop, or carrying more fibres than its cable, that the ladder answered with drop
  // cable because `cableFor` falls back to the largest rung. That is how a 494.8 m feeder came out as
  // six bundled 2-fibre drop cables and ranked `ok` (gh#127). Drop cable is the last leg: at most
  // `DROP_CABLE_MAX_M`, at most two fibres, one cable. A span outside that is a candidate refusal
  // naming the rung that cannot buy it - not a silent BOM of drums nobody pulls.
  Array.prototype.push.apply(reasons, dropClassRefusals(plant, registry));
  failures.slice(0, 5).forEach(function (f) {
    reasons.push((f.name || f.ont) + ': ' + (f.error || (f.result && f.result.reasons.join('; '))));
  });
  if (failures.length > 5) reasons.push('and ' + (failures.length - 5) + ' more ONT(s) failing');

  const metrics = {
    onts: onts,
    spans: plant.spans.length,
    closures: closures,
    splitters: splitters,
    splices: splices,
    cableM: bom.cableM,
    fibreMetres: bom.fibreMetres,
    designM: bom.designM,
    worstHeadroomDb: headrooms.length ? Math.min.apply(null, headrooms) : null,
    launchWindowOnts: hotLaunch.length,
    marginalOnts: marginalOnts.length,
    upstreamFailOnts: upstreamFailures.length,
    bestHeadroomDb: headrooms.length ? Math.max.apply(null, headrooms) : null,
    longestRunM: plant.spans.reduce(function (n, s) { return Math.max(n, s.lengthM); }, 0),
    drums: bom.lines.reduce(function (n, l) { return n + l.drums; }, 0)
  };

  let cost = null;
  let costBreakdown = null;
  const unpricedCable = [];
  const unpricedTerms = [];
  if (opts.costs) {
    // Every cable the BOM builds with must carry a price. A model that leaves one out is not a
    // money model - charging it 0 makes the design that uses it look free - so the models are
    // collected here and `synthesise` refuses the request once every candidate has been built,
    // naming all of them rather than the first one met.
    //
    // Cable is priced on `purchaseM`, not `designM`: drums are bought whole and rounded once per
    // model (SPEC §5), so the metres nobody sells are metres somebody pays for. Pricing the design
    // length quoted three drums as 1.4 km of cable and let the money ranking disagree with the BOM
    // it had just built. `designM` stays the length metric; `cost` is what the purchase order says.
    let cableCost = 0;
    for (const line of bom.lines) {
      const perM = opts.costs.cablePerM[line.model];
      if (perM === undefined) { unpricedCable.push(line.model); continue; }
      cableCost += perM * line.purchaseM;
    }
    // A term the model does not price is not a term that costs nothing. The three labour/parts terms
    // are optional on the shape, and a missing one was multiplied by its count as 0 - so a cable-only
    // model answered `objective: "cost"`, `cost: 5400` for a 20-house estate whose priced total is
    // 8488 (23 closures at 120, 26 splices at 8, 3 splitters at 40 = 3088 unpriced), with
    // `costBreakdown.closures: 0` naming a price the caller never gave. That is the same default a
    // missing attenuation or an unpriced cable is refused for (SPEC 8), on the one number a money
    // ranking is bought on. A term the design actually builds is collected and `synthesise` refuses
    // the request; a term with a zero count needs no price, because the design never uses it.
    const spliceCost = isNum(opts.costs.splice) ? opts.costs.splice * splices : 0;
    const closureCost = isNum(opts.costs.closure) ? opts.costs.closure * closures : 0;
    const splitterCost = isNum(opts.costs.splitter) ? opts.costs.splitter * splitters : 0;
    if (splices > 0 && !isNum(opts.costs.splice)) unpricedTerms.push('splice');
    if (closures > 0 && !isNum(opts.costs.closure)) unpricedTerms.push('closure');
    if (splitters > 0 && !isNum(opts.costs.splitter)) unpricedTerms.push('splitter');
    if (unpricedCable.length || unpricedTerms.length) {
      cost = null;
    } else {
      // A ranked-by-money verdict without its terms is as unreviewable as a budget without its
      // breakdown (SPEC §4): report the cable, splice, closure and splitter terms and their sum.
      cableCost = round(cableCost, 2);
      cost = round(cableCost + spliceCost + closureCost + splitterCost, 2);
      costBreakdown = {
        cable: cableCost,
        splices: round(spliceCost, 2),
        closures: round(closureCost, 2),
        splitters: round(splitterCost, 2),
        total: cost
      };
    }
  }
  metrics.cost = cost;
  metrics.costBreakdown = costBreakdown;
  // Which cost terms the model left unsaid. Not a price and never read as one: `synthesise` refuses
  // the request rather than rank on a total that is missing a term, and the breakdown is null for the
  // same candidate, so nothing downstream can read `closures: 0` as a free closure again.
  metrics.costUnpriced = Array.from(new Set(unpricedTerms)).sort();

  // One sentence for the upstream direction, built from the rows rather than per ONT - a design of 300
  // drops that repeated the same failure 300 times would be unreadable. The sentence lives in
  // `budget.upstreamNote` beside the band note, because the printed plan needs the same one and two
  // copies of a paragraph this specific drift apart.
  const upstreamReport = budgetModule.upstreamNote(upstream, {
    marginDb: isNum(opts.marginDb) ? opts.marginDb : DEFAULTS.marginDb
  });
  // Said once for the plant rather than once per ONT: each budget row carries its own pad
  // (`launchWindowPad`), and a design of 300 drops that repeated the same sentence 300 times would be
  // unreadable. What the report needs is how much of the estate is in the band and what the worst of it
  // costs - the pad a hot module needs, and whether the margin and the class budget can fund it.
  //
  // The sentence itself lives in `budget.launchWindowNote`, because the printed plan needs the same
  // one: two copies of a paragraph this specific drift apart, and the copy that drifts is the one a
  // crew reads.
  const bandNote = budgetModule.launchWindowNote(budgets, {
    marginDb: isNum(opts.marginDb) ? opts.marginDb : DEFAULTS.marginDb,
    // One pad serves both directions of the ODN, so the size this report names has to clear both
    // receivers: a C+ estate 3 km out is 3 dB in the downstream band and 5 dB in the upstream one, and
    // naming the downstream figure sent a crew out with a pad that left the OLT receiver over its
    // overload point at the top of the ONT's window (#233).
    other: upstream
  });
  const launchWindowNote = bandNote ? bandNote.text : null;

  // One sentence for the plant, naming the ONT whose figure is tightest. `feasible` stays true and the
  // verdict stays `marginal`: this is a report of the decision, not a second failure rule - the same
  // product line as the launch-window band (#111, #132). Ties break on the ONT id so the chosen row
  // never depends on build order.
  let marginalNote = null;
  if (marginalOnts.length) {
    const tightness = function (b) {
      // How much room is left on the two verdicts, in dB: the smaller of the margin slack and the
      // class headroom is what makes a design marginal, so the smallest of those is the worst row.
      const marginSlack = b.result.headroomDb - (isNum(opts.marginDb) ? opts.marginDb : DEFAULTS.marginDb);
      return Math.min(marginSlack, b.result.classHeadroomDb);
    };
    const ordered = marginalOnts.slice().sort(function (a, b) {
      const diff = tightness(a) - tightness(b);
      if (diff !== 0) return diff;
      return cmpIds(String(a.ont), String(b.ont));
    });
    const worst = ordered[0];
    const others = marginalOnts.length - 1;
    marginalNote = marginalOnts.length + ' of ' + budgets.length + ' ONT' +
      (budgets.length === 1 ? '' : 's') + ' pass' + (marginalOnts.length === 1 ? 'es' : '') +
      ' only marginally: ' + (worst.name || worst.ont) + ' - ' + worst.result.marginalReason +
      (others > 0 ? ' (and ' + others + ' more ONT' + (others === 1 ? '' : 's') + ' in the same band)' : '') +
      '. The design still builds - marginal is not a failure - but the figure is inside 2 dB of the ' +
      'design margin or 1 dB of the class budget, so it is a decision to make, not a clean plan';
  }

  // Keyed by node id: the two passes walk the same plant in the same order, but joining on order
  // would hide a plant whose ONT list changed between them.
  const upstreamByOnt = new Map();
  upstream.forEach(function (b) { if (b && b.result) upstreamByOnt.set(String(b.ont), b.result); });

  return {
    technology: meta.technology,
    label: meta.label,
    settings: meta.settings,
    feasible: reasons.length === 0,
    // Not part of any response: `synthesise` reads it to refuse a price list that cannot rank the
    // candidates it is about to compare, and the candidate table never carries this field.
    unpricedCable: Array.from(new Set(unpricedCable)).sort(),
    // The same contract for the other three terms: read by `synthesise` to refuse the request, never
    // part of the candidate table.
    unpricedTerms: Array.from(new Set(unpricedTerms)).sort(),
    reasons: reasons,
    warnings: structural.warnings
      // An upstream failure is the strongest thing this report can say, so it reads first.
      .concat(upstreamReport ? [upstreamReport.text] : [])
      .concat(launchWindowNote ? [launchWindowNote] : [])
      .concat(marginalNote ? [marginalNote] : []),
    metrics: metrics,
    bom: bom,
    budgets: budgets.map(function (b) {
      // Both directions on one row. A row that carried only its downstream verdict is what made this
      // report read as a clean design; `upstreamVerdict` is null when that pass could not budget the
      // row at all, and the downstream row's `error` already says why.
      const up = upstreamByOnt.get(String(b.ont));
      return {
        ont: b.ont,
        name: b.name,
        verdict: b.result ? b.result.verdict : 'fail',
        marginalReason: b.result ? b.result.marginalReason : null,
        headroomDb: b.result ? b.result.headroomDb : null,
        rxPowerDbm: b.result ? b.result.rxPowerDbm : null,
        launchWindowPad: b.result ? b.result.launchWindowPad : null,
        upstreamVerdict: up ? up.verdict : null,
        upstreamRxPowerDbm: up ? up.rxPowerDbm : null,
        error: b.error || null
      };
    }),
    plant: plant
  };
}

function finalise(plant, opts, registry, technology, meta) {
  return evaluate(plant, opts, registry, {
    technology: technology,
    label: meta.label,
    settings: meta.settings,
    // One address can be reported by several trees (a PON feeder and its own distribution, say).
    unresolved: Array.from(new Set(meta.unresolved || []))
  });
}

// ---------------------------------------------------------------- public

/**
 * Ranking. Money when the caller supplied a cost model, otherwise fibre-metres - the quantity cable
 * price actually tracks - with plain metres, splices and closures as tie-breaks. Two candidates that
 * tie on all of those are ordered by name so the result never depends on build order.
 */
function scoreOf(candidate, opts) {
  const m = candidate.metrics;
  const primary = opts.costs && isNum(m.cost) ? m.cost : m.fibreMetres;
  const speed = candidate.settings && candidate.settings.speedMbps ? candidate.settings.speedMbps : 0;
  return [primary, m.cableM, m.splices, m.closures, speed, candidate.technology];
}

function compareCandidates(a, b, opts) {
  const sa = scoreOf(a, opts);
  const sb = scoreOf(b, opts);
  for (let i = 0; i < sa.length - 1; i++) {
    if (sa[i] !== sb[i]) return sa[i] - sb[i];
  }
  return cmpIds(String(sa[sa.length - 1]), String(sb[sb.length - 1]));
}

function runsOf(plant, routeMethod) {
  return plant.spans.map(function (span) {
    return {
      id: span.id,
      from: span.from,
      to: span.to,
      cable: span.cable,
      lengthM: span.lengthM,
      bundles: span.bundles || 1,
      strands: span.strands ? span.strands.length : 0,
      purpose: span.purpose || 'tree',
      feedsOnts: span.feedsOnts || (span.purpose === 'drop' ? 1 : null),
      method: routeMethod,
      route: span.route || null
    };
  });
}

function describe(candidate) {
  const m = candidate.metrics;
  return candidate.label + ': ' + m.onts + ' ONT(s), ' + m.cableM + ' m of cable (' +
    m.fibreMetres + ' fibre-metres), ' + m.splitters + ' splitter(s), ' + m.closures + ' closure(s)' +
    (m.worstHeadroomDb === null ? '' : ', worst headroom ' + m.worstHeadroomDb + ' dB') +
    // Said in the line that picks the design, not only in a warning under it: a candidate chosen for
    // its cost is still a candidate whose upstream direction fails.
    (m.upstreamFailOnts ? ', ' + m.upstreamFailOnts + ' of ' + m.onts + ' failing upstream' : '');
}

/**
 * Synthesise designs for a demand list and return the best one.
 *
 * `opts`:
 *   headEnd      { lat, lon, name? }                       required
 *   technology   'auto' | 'pon' | 'active'                 (default 'auto')
 *   network      street/duct geometry: KML text, an array of polylines, or { edges: [...] }
 *   maxSnapM     how far a property may sit from the network (default 250 m)
 *   routeFactor  straight-line multiplier, used only without a network (default 1.2)
 *   marginDb     optical design margin                     (default 3)
 *   pon          { ratios, olt, ont, maxDropM }
 *   active       { headEndOptic, cpeOptic, optics }
 *   ladder       cable models, richest first (absent or empty takes DEFAULT_LADDER, noted)
 *   costs        { cablePerM: { model: n }, splice, closure, splitter }   optional
 *
 * Returns `{ ok, demand, headEnd, routeMethod, objective, candidates, best, plant, runs, rationale,
 * notes }`. With `ok: false` there is no best, and every candidate carries the reasons it was refused.
 */
function synthesise(demandInput, userOptions, registry) {
  if (!registry) throw new TypeError('synthesise needs a parts registry');
  const opts = options(userOptions, registry);
  if (!opts.headEnd || !isNum(opts.headEnd.lat) || !isNum(opts.headEnd.lon)) {
    throw new TypeError('opts.headEnd { lat, lon } is required - a design needs somewhere to start from');
  }
  if (!geo.isCoordinate(opts.headEnd)) throw new Error('opts.headEnd is not a valid coordinate');

  const demand = demandModule.prepare(demandInput, {});
  const notes = [];
  const candidates = [];

  let graph = null;
  let routeMethod = 'straight-line x' + opts.routeFactor;
  if (opts.network) {
    graph = street.buildGraph(opts.network, {
      joinToleranceM: opts.joinToleranceM,
      precision: street.VERTEX_PRECISION
    });
    const stats = graph.stats();
    routeMethod = 'street-graph (' + stats.edges + ' edges, ' + stats.lengthKm + ' km)';
    notes.push('Routed along ' + stats.edges + ' street edges (' + stats.lengthKm + ' km of network); ' +
      'addresses farther than ' + opts.maxSnapM + ' m from a street are reported as unresolved.');
  } else {
    notes.push('No street network supplied: runs are straight-line x' + opts.routeFactor + '.');
  }
  if (!opts.ladderSupplied) {
    // A design that picked the cable ladder says which one, or the BOM's models cannot be checked
    // against what the caller asked for - and an absent ladder is the common case, so the note is
    // the only place the default is visible.
    notes.push('No cable ladder supplied: spans are bought from the default cable ladder ' +
      DEFAULTS.ladder.join(', ') + '.');
  }

  const wantsPon = opts.technology === 'auto' || opts.technology === 'pon';
  const wantsActive = opts.technology === 'auto' || opts.technology === 'active';

  if (wantsPon) {
    for (const ratio of opts.pon.ratios) {
      const candidate = buildPon(demand, opts, registry, ratio, graph);
      if (candidate) candidates.push(candidate);
      else notes.push('PON 1:' + ratio + ' skipped: no splitter part "plc-1x' + ratio + '-sca" in the catalogue');
    }
    if (!candidates.length) notes.push('no PON candidate could be built from the requested ratios');
  }
  if (wantsActive) {
    const optics = Array.isArray(opts.active.optics) && opts.active.optics.length
      ? opts.active.optics
      : [{ headEndOptic: opts.active.headEndOptic, cpeOptic: opts.active.cpeOptic }];
    for (const optic of optics) {
      candidates.push(buildActiveTree(demand, opts, registry, optic, graph));
      candidates.push(buildActiveHomeRun(demand, opts, registry, optic, graph));
    }
  }
  if (!candidates.length) throw new Error('no candidate topology could be built for technology "' + opts.technology + '"');

  // A money objective with a hole in its price list is refused before anything is ranked. The hole
  // belongs to the caller's input, so it is a 400 at the API (see `asBadRequest`), and the message
  // names every unpriced cable the candidates build with - not just the first one met, which would
  // make the caller fix the list one model per attempt.
  if (opts.costs) {
    const unpriced = new Set();
    for (const candidate of candidates) {
      for (const model of candidate.unpricedCable || []) unpriced.add(model);
    }
    if (unpriced.size) {
      throw new TypeError('costs.cablePerM has no price for ' + Array.from(unpriced).sort().join(', ') +
        ' - a money objective that treats an unpriced cable as free ranks the wrong design; price every cable the design builds with, or omit costs to rank by fibre-metres');
    }
    // Same rule for the three terms that are not cable. `costs` is a price list, so a term it does not
    // mention is not a term that costs nothing: a cable-only model answered `objective: "cost"` with
    // a total short of the purchase by every closure, splice and splitter the design builds. Only a
    // term a candidate actually uses is refused - a topology with no splitter needs no splitter price,
    // and a caller who means "these are free" writes 0, which is a figure this model can rank on.
    const unpricedTerms = new Set();
    for (const candidate of candidates) {
      for (const term of candidate.unpricedTerms || []) unpricedTerms.add(term);
    }
    if (unpricedTerms.size) {
      const named = Array.from(unpricedTerms).sort().map(function (term) { return 'costs.' + term; });
      const list = named.length > 1
        ? named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1]
        : named[0];
      throw new TypeError(list + (named.length > 1 ? ' are' : ' is') + ' not priced, and a design here ' +
        'builds ' + (named.length > 1 ? 'them' : 'it') + ' - a money objective that charges an unsaid ' +
        'term as 0 quotes a total short of what the design costs, so price the term or write 0 to say ' +
        'it costs nothing; omit costs to rank by fibre-metres');
    }
  }

  // The PON port limit is a plant-level constraint the validator cannot see, because it belongs to
  // the OLT part rather than to the tree.
  for (const candidate of candidates) {
    if (candidate.technology !== 'pon') continue;
    const olt = registry.get('olt', opts.pon.olt);
    candidate.settings.ponPortsNeeded = candidate.metrics.splitters;
    if (candidate.metrics.splitters > olt.ports) {
      candidate.feasible = false;
      candidate.reasons.push('needs ' + candidate.metrics.splitters + ' PON port(s) but ' + olt.model + ' has ' + olt.ports);
    }
  }

  const feasible = candidates.filter(function (c) { return c.feasible; });
  feasible.sort(function (a, b) { return compareCandidates(a, b, opts); });

  const best = feasible.length ? feasible[0] : null;
  if (!best) {
    notes.push('every candidate failed: ' + candidates.map(function (c) {
      return c.label + ' (' + (c.reasons[0] || 'no reason recorded') + ')';
    }).join('; '));
  }

  const rationale = [];
  if (best) {
    rationale.push('Chosen: ' + describe(best) + '.');
    const others = candidates.filter(function (c) { return c !== best; });
    // One line per technology: the closest competitor of each kind, not every ratio and optic
    // variant. Nine near-identical rejections read as noise and bury the comparison that matters.
    const seen = new Set();
    const shown = [];
    let omitted = 0;
    for (const other of others) {
      if (seen.has(other.technology)) { omitted++; continue; }
      seen.add(other.technology);
      shown.push(other);
    }
    for (const other of shown) {
      if (other.feasible) {
        const basis = best.metrics.fibreMetres > 0
          ? other.metrics.fibreMetres / best.metrics.fibreMetres
          : 0;
        const times = basis > 0 ? round(basis, 2) : null;
        rationale.push('Rejected ' + other.label + ': feasible but ' +
          (best.metrics.cost !== null && other.metrics.cost !== null
            ? 'costs ' + other.metrics.cost + ' against ' + best.metrics.cost
            : 'needs ' + other.metrics.cableM + ' m of cable and ' + other.metrics.fibreMetres +
              ' fibre-metres' + (times ? ' (' + times + 'x)' : '')));
      } else {
        rationale.push('Rejected ' + other.label + ': ' + (other.reasons[0] || 'infeasible'));
      }
    }
    if (omitted > 0) {
      rationale.push(omitted + ' further ratio/optic variant(s) scored worse or were infeasible; ' +
        'every one is in the candidate table with its numbers.');
    }
  }

  return {
    ok: !!best,
    demand: {
      points: demand.points.length,
      rejected: demand.rejected,
      duplicates: demand.duplicates,
      meta: demand.meta,
      bbox: demand.bbox
    },
    headEnd: opts.headEnd,
    routeMethod: routeMethod,
    objective: opts.costs ? 'cost' : 'fibre-metres',
    technology: best ? best.technology : null,
    best: best ? {
      technology: best.technology,
      label: best.label,
      settings: best.settings,
      metrics: best.metrics,
      feasible: true,
      warnings: best.warnings
    } : null,
    candidates: candidates.map(function (c) {
      return {
        technology: c.technology,
        label: c.label,
        settings: c.settings,
        feasible: c.feasible,
        reasons: c.reasons,
        metrics: c.metrics,
        budgets: c.budgets,
        bom: c.bom,
        plant: opts.includeAllPlants || c === best ? c.plant : undefined
      };
    }),
    plant: best ? best.plant : null,
    runs: best ? runsOf(best.plant, routeMethod) : [],
    rationale: rationale,
    notes: notes
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  DEFAULT_LADDER: DEFAULT_LADDER,
  synthesise: synthesise,
  minimumSpanningTree: minimumSpanningTree,
  clusterPoints: clusterPoints,
  cableFor: cableFor,
  cableForSpan: cableForSpan,
  DROP_CABLE_MAX_M: DROP_CABLE_MAX_M,
  runsOf: runsOf
};
