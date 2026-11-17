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
const lengthModule = require('./length');
const street = require('./street');

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

function options(input) {
  const o = input || {};
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
    overlengthPct: isNum(o.overlengthPct) ? o.overlengthPct : DEFAULTS.overlengthPct,
    costs: o.costs || null,
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

function strandList(count, fiberCount) {
  const n = Math.min(count, fiberCount);
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
 * The street provider: snap every terminal, then take the union of shortest paths from the root.
 *
 * Anything the graph cannot reach comes back in `unresolved` rather than being connected by a straight
 * line: an address two kilometres from the nearest street is a design problem, and the caller turns it
 * into an infeasible candidate with that reason.
 */
function streetTree(graph, root, points, opts) {
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

  for (const node of tree.nodes) {
    if (node.isRoot) continue;
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
      plant.spans.push({
        id: cfg.prefix + 'drop-' + terminalId,
        from: idOf.get(node.key), to: ontId,
        cable: cfg.terminalCable,
        lengthM: Math.max(1, round(spur, 1)),
        strands: cfg.terminalFibres === 1 ? [1] : [1, 2],
        purpose: cfg.dropPurpose,
        feedsOnts: 1,
        route: spur > 0 ? [{ lat: node.lat, lon: node.lon }, { lat: point.lat, lon: point.lon }] : null
      });
    }
  }

  for (const edge of tree.edges) {
    const fibres = Math.max(cfg.minFibres, edge.terminals * cfg.fibresPerTerminal);
    const cable = cableForSpan(fibres, edge.lengthM, cfg.ladder, registry);
    const bundles = Math.max(1, Math.ceil(fibres / cable.fiberCount));
    plant.spans.push({
      id: cfg.prefix + 's-' + edge.from + '-' + edge.to,
      from: idOf.get(edge.from), to: idOf.get(edge.to),
      cable: cable.model,
      lengthM: edge.lengthM,
      strands: strandList(fibres, cable.fiberCount),
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
      strands: strandList(fibres, cable.fiberCount),
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
    ? streetTree(graph, opts.headEnd, demand.points, opts)
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
      const lengthM = Math.max(1, round(path.lengthM + snapped.spurM, 1));
      plant.spans.push({
        id: 's-' + (i + 1), from: 'n-headend', to: 'n-ont-' + point.id,
        cable: lengthM > 300 ? 'g652d-loose-12' : 'g657a2-drop-2',
        lengthM: lengthM, strands: [1, 2], purpose: 'home-run', feedsOnts: 1,
        route: path.route.concat([{ lat: point.lat, lon: point.lon }])
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
        cable: lengthM > 300 ? 'g652d-loose-12' : 'g657a2-drop-2',
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
    ? streetTree(graph, opts.headEnd, sitePoints, opts)
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
    const prev = byModel.get(cable.model) || { model: cable.model, label: cable.label, fiberCount: cable.fiberCount, routeM: 0, fibres: 0 };
    prev.routeM = round(prev.routeM + span.lengthM * bundles, 1);
    prev.fibres += span.strands ? span.strands.length : 0;
    byModel.set(cable.model, prev);
  }
  const lines = Array.from(byModel.values()).map(function (row) {
    const calc = lengthModule.cableToBuy({ routeM: row.routeM, overlengthPct: opts.overlengthPct, splices: 0, closures: 0, drumM: 2000 });
    return {
      model: row.model,
      label: row.label,
      fiberCount: row.fiberCount,
      routeM: row.routeM,
      designM: calc.designM,
      drums: calc.drums,
      purchaseM: calc.purchaseM
    };
  }).sort(function (a, b) { return cmpIds(a.model, b.model); });

  const cableM = round(lines.reduce(function (n, l) { return n + l.routeM; }, 0), 1);
  const designM = round(lines.reduce(function (n, l) { return n + l.designM; }, 0), 1);
  return { lines: lines, cableM: cableM, designM: designM, fibreMetres: round(fibreMetres, 1) };
}

function evaluate(plant, opts, registry, meta) {
  const structural = network.validate(plant, registry);
  const budgets = network.allOntBudgets(plant, registry, { marginDb: opts.marginDb, direction: 'down' });

  const failures = budgets.filter(function (b) { return b.error || (b.result && b.result.verdict === 'fail'); });
  const headrooms = budgets.filter(function (b) { return b.result && isNum(b.result.headroomDb); })
    .map(function (b) { return b.result.headroomDb; });

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
    bestHeadroomDb: headrooms.length ? Math.max.apply(null, headrooms) : null,
    longestRunM: plant.spans.reduce(function (n, s) { return Math.max(n, s.lengthM); }, 0),
    drums: bom.lines.reduce(function (n, l) { return n + l.drums; }, 0)
  };

  let cost = null;
  if (opts.costs) {
    cost = 0;
    for (const line of bom.lines) {
      const perM = opts.costs.cablePerM && opts.costs.cablePerM[line.model];
      cost += (isNum(perM) ? perM : 0) * line.designM;
    }
    if (isNum(opts.costs.splice)) cost += opts.costs.splice * splices;
    if (isNum(opts.costs.closure)) cost += opts.costs.closure * closures;
    if (isNum(opts.costs.splitter)) cost += opts.costs.splitter * splitters;
    cost = round(cost, 2);
  }
  metrics.cost = cost;

  return {
    technology: meta.technology,
    label: meta.label,
    settings: meta.settings,
    feasible: reasons.length === 0,
    reasons: reasons,
    warnings: structural.warnings,
    metrics: metrics,
    bom: bom,
    budgets: budgets.map(function (b) {
      return {
        ont: b.ont,
        name: b.name,
        verdict: b.result ? b.result.verdict : 'fail',
        headroomDb: b.result ? b.result.headroomDb : null,
        rxPowerDbm: b.result ? b.result.rxPowerDbm : null,
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
    (m.worstHeadroomDb === null ? '' : ', worst headroom ' + m.worstHeadroomDb + ' dB');
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
 *   ladder       cable models, richest first
 *   costs        { cablePerM: { model: n }, splice, closure, splitter }   optional
 *
 * Returns `{ ok, demand, headEnd, routeMethod, objective, candidates, best, plant, runs, rationale,
 * notes }`. With `ok: false` there is no best, and every candidate carries the reasons it was refused.
 */
function synthesise(demandInput, userOptions, registry) {
  if (!registry) throw new TypeError('synthesise needs a parts registry');
  const opts = options(userOptions);
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
