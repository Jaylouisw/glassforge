'use strict';
/**
 * Street and duct geometry: the graph a run actually follows.
 *
 * Straight-line distance times a detour factor is a guess. A cable follows a street, a duct bank or a
 * pole line, and on a real development the difference is not a constant factor - it is "up to the
 * junction, along the main road, back down the cul-de-sac". This module turns imported geometry into
 * a graph and answers the only two questions the designer asks of it:
 *
 *   routeTree()  what does the cable tree look like from here to these properties?
 *   routePath()  what is the run from here to this one property?
 *
 * Geometry comes in as KML (`kml.js` already reads it) or as plain JSON polylines. No map download:
 * the server makes no outbound requests, so the graph is whatever the user imported.
 *
 * Three decisions worth knowing:
 *
 * 1. **Terminals are snapped onto edges, and the gap is a real length.** A house is not on the
 *    centreline; the distance from the property to the point it joins the street is the drop, and it
 *    is carried as `spurM` rather than rounded away.
 * 2. **The tree is the union of shortest paths from the root, pruned to nothing that serves no
 *    terminal.** That is not the optimal Steiner tree, and pretending otherwise would be a much
 *    larger piece of work; it is the tree a planner actually draws, it is deterministic, and its
 *    length is the true sum of street edges rather than the same segment counted once per customer.
 * 3. **Degree-2 junctions with nothing attached are contracted.** A street polyline with forty
 *    vertices is one cable run, not forty spans - the route is kept as geometry, the length as one
 *    number.
 */

const geo = require('./geo');
const kml = require('./kml');

const VERTEX_PRECISION = 6;        // ~0.11 m: two vertices this close are the same place
const DEFAULT_JOIN_M = 1.5;        // KML lines from different drawings rarely share exact endpoints
const DEFAULT_MAX_SNAP_M = 250;    // farther than this from any street, a property is not connected

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(n, places) {
  const f = Math.pow(10, places === undefined ? 2 : places);
  return Math.round(n * f) / f;
}
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Accept the several shapes a caller may hand us and return `[{ id, coords }]`. */
function parseNetwork(input) {
  if (!input) throw new Error('no network geometry: supply edges or KML');

  if (typeof input === 'string') {
    return fromKml(input);
  }
  if (Array.isArray(input)) {
    return input.map(function (line, i) { return normaliseLine(line, i); }).filter(Boolean);
  }
  if (input.kml) return fromKml(input.kml);
  if (Array.isArray(input.edges)) {
    return input.edges.map(function (edge, i) { return normaliseLine(edge, i); }).filter(Boolean);
  }
  if (Array.isArray(input.routes)) {
    return input.routes.map(function (route, i) { return normaliseLine(route, i); }).filter(Boolean);
  }
  throw new Error('network geometry must be KML text, an array of polylines, or { edges: [...] }');
}

function fromKml(text) {
  const parsed = kml.parseKml(text);
  const classified = kml.classify(parsed, {});
  const lines = classified.routes.map(function (route, i) {
    return { id: 'kml-' + (i + 1), coords: route.points };
  });
  if (!lines.length) {
    throw new Error('the KML contains no LineStrings - a street network needs lines, not points ' +
      '(' + classified.points.length + ' point(s) were found instead)');
  }
  return lines;
}

function normaliseLine(line, i) {
  const coords = line && (line.coords || line.points || line.geometry);
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const clean = coords.filter(function (p) { return geo.isCoordinate(p); })
    .map(function (p) { return { lat: p.lat, lon: p.lon }; });
  if (clean.length < 2) return null;
  return { id: line.id || 'e' + i, coords: clean };
}

class Graph {
  constructor(opts) {
    const o = opts || {};
    this.precision = o.precision === undefined ? VERTEX_PRECISION : o.precision;
    this.joinToleranceM = isNum(o.joinToleranceM) ? o.joinToleranceM : DEFAULT_JOIN_M;
    this.nodes = new Map();
    this.edges = new Map();
    this.adjacency = new Map();
    this.nextNode = 1;
    this.nextEdge = 1;
    this._grid = new Map();
  }

  _cell(point) {
    const size = Math.max(1, this.joinToleranceM);
    const latStep = size / 111132.95;
    const lonStep = size / (111319.49 * Math.max(0.01, Math.cos(point.lat * Math.PI / 180)));
    return {
      x: Math.round(point.lon / lonStep),
      y: Math.round(point.lat / latStep)
    };
  }

  /**
   * Find a node at `point`, or create one. Near-coincident vertices are merged within
   * `joinToleranceM` (checked in the 9 surrounding grid cells, so two lines that meet either side of
   * a cell boundary still join).
   */
  nodeAt(point) {
    const cell = this._cell(point);
    let best = null;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this._grid.get((cell.x + dx) + ':' + (cell.y + dy));
        if (!bucket) continue;
        for (const id of bucket) {
          const node = this.nodes.get(id);
          const d = geo.distanceM(node, point);
          if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) <= 1e-9 && best && cmp(node.id, best) < 0)) {
            bestDistance = d;
            best = node.id;
          }
        }
      }
    }
    if (best && bestDistance <= this.joinToleranceM) return best;

    const id = 'v' + this.nextNode++;
    this.nodes.set(id, { id: id, lat: point.lat, lon: point.lon });
    this.adjacency.set(id, []);
    const bucketKey = cell.x + ':' + cell.y;
    if (!this._grid.has(bucketKey)) this._grid.set(bucketKey, []);
    this._grid.get(bucketKey).push(id);
    return id;
  }

  addEdge(aId, bId, geometry) {
    if (aId === bId) return null;
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    const points = geometry && geometry.length >= 2 ? geometry : [a, b];
    const lengthM = geo.pathLengthM(points);
    if (!(lengthM > 0)) return null;
    const id = 'e' + this.nextEdge++;
    const edge = { id: id, a: aId, b: bId, lengthM: lengthM, geometry: points };
    this.edges.set(id, edge);
    this.adjacency.get(aId).push({ edgeId: id, to: bId, lengthM: lengthM });
    this.adjacency.get(bId).push({ edgeId: id, to: aId, lengthM: lengthM });
    return edge;
  }

  addLine(line) {
    let previous = null;
    for (const point of line.coords) {
      const id = this.nodeAt(point);
      if (previous && previous !== id) {
        this.addEdge(previous, id, [{ lat: this.nodes.get(previous).lat, lon: this.nodes.get(previous).lon }, point]);
      }
      previous = id;
    }
  }

  stats() {
    let lengthM = 0;
    for (const edge of this.edges.values()) lengthM += edge.lengthM;
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      lengthM: round(lengthM, 1),
      lengthKm: round(lengthM / 1000, 3)
    };
  }
}

function buildGraph(input, opts) {
  const graph = new Graph(opts);
  const lines = parseNetwork(input);
  if (!lines.length) throw new Error('no usable polylines in the network geometry (each needs at least two coordinates)');
  for (const line of lines) graph.addLine(line);
  planarize(graph);
  const stats = graph.stats();
  if (!stats.edges) throw new Error('the network geometry produced no edges - are all the coordinates distinct?');
  return graph;
}

/** Project a point onto one edge. Returns `{ edgeId, segIndex, t, at, distM }`. */
function projectOnEdge(edge, point) {
  let best = null;
  for (let i = 1; i < edge.geometry.length; i++) {
    const a = edge.geometry[i - 1];
    const b = edge.geometry[i];
    const mPerDegLat = 111132.95;
    const mPerDegLon = 111319.49 * Math.cos((a.lat * Math.PI) / 180);
    const bx = (b.lon - a.lon) * mPerDegLon;
    const by = (b.lat - a.lat) * mPerDegLat;
    const px = (point.lon - a.lon) * mPerDegLon;
    const py = (point.lat - a.lat) * mPerDegLat;
    const len2 = bx * bx + by * by;
    let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
    t = Math.max(0, Math.min(1, t));
    const at = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    const distM = geo.distanceM(point, at);
    if (!best || distM < best.distM - 1e-9) {
      best = { edgeId: edge.id, segIndex: i, t: t, at: at, distM: distM };
    }
  }
  return best;
}

/** Project a point onto the nearest edge. Returns `{ edgeId, segIndex, t, at, distM }` or null. */
function nearestOnEdges(graph, point) {
  let best = null;
  const edgeIds = Array.from(graph.edges.keys()).sort(cmp);
  for (const edgeId of edgeIds) {
    const found = projectOnEdge(graph.edges.get(edgeId), point);
    if (!found) continue;
    if (!best || found.distM < best.distM - 1e-9 ||
        (Math.abs(found.distM - best.distM) <= 1e-9 && cmp(edgeId, best.edgeId) < 0)) {
      best = found;
    }
  }
  return best;
}

/**
 * Split edges at vertices that land on their interior.
 *
 * A T-junction is the normal case in imported geometry: a side street drawn *from* the main road,
 * where the main road has no vertex at the junction. Merging only coincident vertices leaves the two
 * lines as separate components, so nothing on the side street is reachable from the main road - and
 * every property there comes back "not on the street network". This makes the graph planar, which is
 * what "connected" means for a street network.
 */
function planarize(graph, toleranceM) {
  const tol = isNum(toleranceM) ? toleranceM : graph.joinToleranceM;
  let splits = 0;
  const nodeIds = Array.from(graph.nodes.keys()).sort(cmp);
  for (const nodeId of nodeIds) {
    const node = graph.nodes.get(nodeId);
    const edgeIds = Array.from(graph.edges.keys()).sort(cmp);
    for (const edgeId of edgeIds) {
      const edge = graph.edges.get(edgeId);
      if (!edge || edge.a === nodeId || edge.b === nodeId) continue;
      const found = projectOnEdge(edge, node);
      if (!found || found.distM > tol) continue;
      if (found.t <= 1e-9 || found.t >= 1 - 1e-9) continue;
      const before = edge.geometry.slice(0, found.segIndex).concat([node]);
      const after = [node].concat(edge.geometry.slice(found.segIndex));
      removeEdge(graph, edgeId);
      graph.addEdge(edge.a, nodeId, before);
      graph.addEdge(nodeId, edge.b, after);
      splits++;
    }
  }
  return splits;
}

/**
 * Snap a point onto the graph, splitting the edge it lands on.
 *
 * Returns `{ nodeId, spurM }`: the node to route from/to, and the length of the gap between the
 * property and the street (its drop, not a rounding error). Returns null when the point is farther
 * than `maxSnapM` from any edge - a property two kilometres from the nearest street is unresolved,
 * not "connected by a straight line".
 */
function snap(graph, point, opts) {
  const o = opts || {};
  const maxSnapM = isNum(o.maxSnapM) ? o.maxSnapM : DEFAULT_MAX_SNAP_M;
  const found = nearestOnEdges(graph, point);
  if (!found) return null;
  if (found.distM > maxSnapM) return null;

  const edge = graph.edges.get(found.edgeId);
  // Landing on an existing vertex needs no split.
  if (found.t <= 1e-6 && found.segIndex === 1) {
    return { nodeId: edge.a, spurM: round(found.distM, 2), at: graph.nodes.get(edge.a) };
  }
  if (found.t >= 1 - 1e-6 && found.segIndex === edge.geometry.length - 1) {
    return { nodeId: edge.b, spurM: round(found.distM, 2), at: graph.nodes.get(edge.b) };
  }

  const nodeId = graph.nodeAt(found.at);
  // Existing vertex? then the split is unnecessary.
  if (nodeId === edge.a || nodeId === edge.b) {
    return { nodeId: nodeId, spurM: round(found.distM, 2), at: graph.nodes.get(nodeId) };
  }

  const before = edge.geometry.slice(0, found.segIndex).concat([found.at]);
  const after = [found.at].concat(edge.geometry.slice(found.segIndex));
  // Remove the original edge and put the two halves in its place, keeping the node pair.
  removeEdge(graph, edge.id);
  graph.addEdge(edge.a, nodeId, before);
  graph.addEdge(nodeId, edge.b, after);
  return { nodeId: nodeId, spurM: round(found.distM, 2), at: graph.nodes.get(nodeId) };
}

function removeEdge(graph, edgeId) {
  const edge = graph.edges.get(edgeId);
  if (!edge) return;
  graph.edges.delete(edgeId);
  for (const id of [edge.a, edge.b]) {
    const list = graph.adjacency.get(id) || [];
    graph.adjacency.set(id, list.filter(function (entry) { return entry.edgeId !== edgeId; }));
  }
}

/** Dijkstra with a deterministic tie-break: equal distance resolves by node id. */
function dijkstra(graph, rootId) {
  const dist = new Map();
  const parent = new Map();
  const visited = new Set();
  for (const id of graph.nodes.keys()) dist.set(id, Infinity);
  if (!graph.nodes.has(rootId)) return { dist: dist, parent: parent };
  dist.set(rootId, 0);

  while (true) {
    let current = null;
    let best = Infinity;
    for (const id of Array.from(graph.nodes.keys()).sort(cmp)) {
      if (visited.has(id)) continue;
      const d = dist.get(id);
      if (d < best - 1e-9) { best = d; current = id; }
    }
    if (current === null) break;
    visited.add(current);
    const neighbours = (graph.adjacency.get(current) || []).slice()
      .sort(function (x, y) { return cmp(x.to, y.to); });
    for (const entry of neighbours) {
      const candidate = dist.get(current) + entry.lengthM;
      if (candidate < dist.get(entry.to) - 1e-9) {
        dist.set(entry.to, candidate);
        parent.set(entry.to, { nodeId: current, edgeId: entry.edgeId });
      }
    }
  }
  return { dist: dist, parent: parent };
}

function geometryAtoB(graph, edge, fromId) {
  const points = edge.geometry;
  const forward = edge.a === fromId;
  return forward ? points.slice() : points.slice().reverse();
}

/** Walk parents from `nodeId` back to the root, returning an ordered path. */
function pathFromParents(graph, rootId, nodeId, parent) {
  if (nodeId === rootId) return { nodes: [rootId], edges: [], lengthM: 0, route: [] };
  const chain = [];
  let cursor = nodeId;
  const guard = new Set();
  while (cursor !== rootId) {
    if (guard.has(cursor)) throw new Error('cycle while walking the shortest-path tree at ' + cursor);
    guard.add(cursor);
    const step = parent.get(cursor);
    if (!step) return null;
    chain.push({ from: step.nodeId, to: cursor, edgeId: step.edgeId });
    cursor = step.nodeId;
  }
  chain.reverse();
  const nodes = [rootId];
  const route = [];
  let lengthM = 0;
  for (const step of chain) {
    const edge = graph.edges.get(step.edgeId);
    const geometry = geometryAtoB(graph, edge, step.from);
    for (const point of geometry) {
      const last = route[route.length - 1];
      if (!last || last.lat !== point.lat || last.lon !== point.lon) route.push({ lat: point.lat, lon: point.lon });
    }
    lengthM += edge.lengthM;
    nodes.push(step.to);
  }
  return { nodes: nodes, edges: chain, lengthM: lengthM, route: route };
}

/**
 * The routed tree: the union of shortest paths from `rootId` to every terminal, pruned to the edges
 * that serve one, contracted between the points a planner would actually mark.
 *
 * `terminals`: `[{ id, nodeId, spurM, label }]`, already snapped.
 * Returns logical nodes and edges (with the street geometry as `route`), the spur per terminal, and
 * any terminal the graph cannot reach.
 */
function routedTree(graph, rootId, terminals, opts) {
  const o = opts || {};
  const spt = dijkstra(graph, rootId);
  const attach = new Map();       // nodeId -> [terminal]
  const unresolved = [];
  for (const terminal of terminals) {
    if (!terminal.nodeId || !spt.dist.has(terminal.nodeId) || spt.dist.get(terminal.nodeId) === Infinity) {
      unresolved.push(terminal.id);
      continue;
    }
    if (!attach.has(terminal.nodeId)) attach.set(terminal.nodeId, []);
    attach.get(terminal.nodeId).push(terminal);
  }

  // Which edges are on a path to a terminal?
  const usedEdges = new Set();
  const usedNodes = new Set([rootId]);
  for (const nodeId of attach.keys()) {
    let cursor = nodeId;
    const guard = new Set();
    while (cursor !== rootId) {
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const step = spt.parent.get(cursor);
      if (!step) break;
      usedEdges.add(step.edgeId);
      usedNodes.add(cursor);
      usedNodes.add(step.nodeId);
      cursor = step.nodeId;
    }
  }

  // Children in the used tree, and the terminal count under each node.
  const children = new Map();
  for (const nodeId of usedNodes) {
    if (nodeId === rootId) continue;
    const step = spt.parent.get(nodeId);
    if (!step) continue;
    if (!children.has(step.nodeId)) children.set(step.nodeId, []);
    children.get(step.nodeId).push(nodeId);
  }
  for (const list of children.values()) list.sort(cmp);

  const terminalCount = new Map();
  const order = [];
  (function walk(id) {
    order.push(id);
    let count = (attach.get(id) || []).length;
    for (const child of children.get(id) || []) count += walk(child);
    terminalCount.set(id, count);
    return count;
  })(rootId);

  // Keep: the root, anything with a terminal attached, any real branch, and anything the caller wants.
  const keep = new Set([rootId]);
  for (const nodeId of usedNodes) {
    if (attach.has(nodeId)) keep.add(nodeId);
    if ((children.get(nodeId) || []).length >= 2) keep.add(nodeId);
    if (o.keep && o.keep(nodeId)) keep.add(nodeId);
  }

  const degree = new Map();
  for (const nodeId of usedNodes) {
    degree.set(nodeId, (children.get(nodeId) || []).length + (nodeId === rootId ? 0 : 1));
  }

  const nodes = [];
  const nodeIndex = new Map();
  function pushNode(nodeId) {
    if (nodeIndex.has(nodeId)) return nodeIndex.get(nodeId);
    const graphNode = graph.nodes.get(nodeId);
    const record = {
      key: nodeId,
      lat: graphNode.lat,
      lon: graphNode.lon,
      terminals: terminalCount.get(nodeId) || 0,
      degree: degree.get(nodeId) || 0,
      attachTerminals: (attach.get(nodeId) || []).map(function (t) { return t.id; }),
      isRoot: nodeId === rootId
    };
    nodes.push(record);
    nodeIndex.set(nodeId, nodes.length - 1);
    return nodeIndex.get(nodeId);
  }

  const edges = [];
  // From every kept node, follow each chain until the next kept node.
  for (const startId of Array.from(keep).sort(cmp)) {
    for (const child of (children.get(startId) || [])) {
      let cursor = child;
      let lengthM = 0;
      const route = [];
      const chainGuard = new Set();
      while (!keep.has(cursor)) {
        if (chainGuard.has(cursor)) break;
        chainGuard.add(cursor);
        const next = (children.get(cursor) || [])[0];
        if (!next) break;
        cursor = next;
      }
      // Rebuild the chain length and geometry from startId to cursor.
      const path = pathFromParents(graph, startId, cursor, spt.parent);
      if (!path) continue;
      lengthM = path.lengthM;
      for (const point of path.route) route.push(point);
      if (!route.length) {
        const a = graph.nodes.get(startId);
        const b = graph.nodes.get(cursor);
        route.push({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
      }
      pushNode(startId);
      pushNode(cursor);
      edges.push({
        from: startId,
        to: cursor,
        lengthM: round(lengthM, 2),
        route: route,
        terminals: terminalCount.get(cursor) || 0
      });
    }
  }

  // A root with nothing under it still has to exist as a node.
  pushNode(rootId);

  const spurs = new Map();
  for (const [nodeId, list] of attach.entries()) {
    for (const terminal of list) spurs.set(terminal.id, terminal.spurM === undefined ? 0 : terminal.spurM);
  }

  return {
    rootId: rootId,
    nodes: nodes,
    edges: edges,
    spurs: spurs,
    unresolved: unresolved,
    terminalCount: terminalCount,
    totalM: round(edges.reduce(function (n, e) { return n + e.lengthM; }, 0), 2),
    dist: spt.dist,
    parent: spt.parent
  };
}

/** One routed run from the root to a terminal: `{ lengthM, route }` or null when unreachable. */
function routePath(graph, rootId, nodeId, spt) {
  const tree = spt || dijkstra(graph, rootId);
  return pathFromParents(graph, rootId, nodeId, tree.parent);
}

module.exports = {
  VERTEX_PRECISION: VERTEX_PRECISION,
  DEFAULT_JOIN_M: DEFAULT_JOIN_M,
  DEFAULT_MAX_SNAP_M: DEFAULT_MAX_SNAP_M,
  Graph: Graph,
  parseNetwork: parseNetwork,
  buildGraph: buildGraph,
  nearestOnEdges: nearestOnEdges,
  projectOnEdge: projectOnEdge,
  planarize: planarize,
  snap: snap,
  dijkstra: dijkstra,
  routedTree: routedTree,
  routePath: routePath
};
