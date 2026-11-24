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
const CROSSING_EPS_M = 0.05;       // shallower than this off the other line is a graze

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
 * every property there comes back "not on the street network".
 */
function splitAtInteriorVertices(graph, tol) {
  let splits = 0;
  const boxes = new Map();
  function boxOf(edge) {
    let box = boxes.get(edge.id);
    if (box) return box;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of edge.geometry) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    box = { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon };
    boxes.set(edge.id, box);
    return box;
  }
  const nodeIds = Array.from(graph.nodes.keys()).sort(cmp);
  for (const nodeId of nodeIds) {
    const node = graph.nodes.get(nodeId);
    // A node outside an edge's bounding box (widened by the tolerance) cannot project onto it, and on
    // a town-sized import that rejection is most of the work: the projection itself is the expensive
    // half, and this pass is quadratic without it.
    const latPad = tol / 111132.95;
    const lonPad = tol / (111319.49 * Math.max(0.01, Math.cos((node.lat * Math.PI) / 180)));
    const edgeIds = Array.from(graph.edges.keys()).sort(cmp);
    for (const edgeId of edgeIds) {
      const edge = graph.edges.get(edgeId);
      if (!edge || edge.a === nodeId || edge.b === nodeId) continue;
      const box = boxOf(edge);
      if (node.lat < box.minLat - latPad || node.lat > box.maxLat + latPad ||
          node.lon < box.minLon - lonPad || node.lon > box.maxLon + lonPad) continue;
      const found = projectOnEdge(edge, node);
      if (!found || found.distM > tol) continue;
      if (found.t <= 1e-9 || found.t >= 1 - 1e-9) continue;
      const before = edge.geometry.slice(0, found.segIndex).concat([node]);
      const after = [node].concat(edge.geometry.slice(found.segIndex));
      removeEdge(graph, edgeId);
      boxes.delete(edgeId);
      graph.addEdge(edge.a, nodeId, before);
      graph.addEdge(nodeId, edge.b, after);
      splits++;
    }
  }
  return splits;
}

/**
 * Where two segments cross with no vertex between them, in coordinates, or null.
 *
 * Both segments are projected into metres around `a1` and each segment's far end is measured against
 * the *other* line, so the test is a pair of signed perpendicular distances: opposite signs on both
 * lines means each line has the other's ends on either side, which is a transversal crossing. A
 * distance under `CROSSING_EPS_M` is not a crossing - that endpoint is lying on the line, a T
 * junction, and `splitAtInteriorVertices` is the pass that owns it.
 */
function segmentCrossing(a1, a2, b1, b2) {
  const mPerDegLat = 111132.95;
  const mPerDegLon = 111319.49 * Math.cos((a1.lat * Math.PI) / 180);
  // A at the origin, with the frame running from A to B; C and D wherever they fall.
  const bx = (a2.lon - a1.lon) * mPerDegLon;
  const by = (a2.lat - a1.lat) * mPerDegLat;
  const cx = (b1.lon - a1.lon) * mPerDegLon;
  const cy = (b1.lat - a1.lat) * mPerDegLat;
  const dx = (b2.lon - a1.lon) * mPerDegLon;
  const dy = (b2.lat - a1.lat) * mPerDegLat;
  const len1 = Math.sqrt(bx * bx + by * by);
  const len2 = Math.sqrt((dx - cx) * (dx - cx) + (dy - cy) * (dy - cy));
  if (!(len1 > 0) || !(len2 > 0)) return null;

  const s1 = (bx * cy - by * cx) / len1;
  const s2 = (bx * dy - by * dx) / len1;
  const s3 = ((dx - cx) * -cy - (dy - cy) * -cx) / len2;
  const s4 = ((dx - cx) * (by - cy) - (dy - cy) * (bx - cx)) / len2;
  function straddles(p, q) {
    return (p > CROSSING_EPS_M && q < -CROSSING_EPS_M) || (p < -CROSSING_EPS_M && q > CROSSING_EPS_M);
  }
  if (!straddles(s1, s2) || !straddles(s3, s4)) return null;
  // The parameter is taken from the pair measured against the *other* line: s1/s2 locate the crossing
  // along B-D, so interpolating A->B with them puts the node three-quarters along a line the road
  // crosses at a quarter - invisible on a symmetric X, wrong on every real one.
  const t = s3 / (s3 - s4);
  return { lat: a1.lat + (a2.lat - a1.lat) * t, lon: a1.lon + (a2.lon - a1.lon) * t };
}

/**
 * Put a vertex where two lines cross between their own vertices.
 *
 * A T-junction has a vertex that lands on a line; a crossing has none on either line, so nothing
 * merges and the graph stays two components. That is every crossing drawn as two separate polylines,
 * which is how most exported KML arrives - and it made a whole road unreachable, reported by name as
 * "not on the street network" when the geometry itself was sound. Two streets at grade meet, so a
 * crossing becomes a node and both edges are cut at it by the vertex pass that follows.
 *
 * The assumption is stated because it is one: two networks that cross *without* connecting - a duct
 * passing under a street on another level - would be joined here. An import that means "no junction"
 * must offset the lines or supply the node itself.
 *
 * Candidates are pruned by a sweep over longitudes and then by bounding box, so a town-sized import
 * does not cost one intersection test per edge pair.
 */
function joinCrossings(graph) {
  const items = [];
  for (const edge of graph.edges.values()) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of edge.geometry) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    items.push({ edge: edge, minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon });
  }
  items.sort(function (x, y) { return cmp(x.minLon, y.minLon) || cmp(x.edge.id, y.edge.id); });

  const points = [];
  for (let i = 0; i < items.length; i++) {
    const one = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const two = items[j];
      if (two.minLon > one.maxLon) break;
      if (two.minLat > one.maxLat || two.maxLat < one.minLat) continue;
      const a = one.edge;
      const b = two.edge;
      if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;
      let found = null;
      for (let p = 1; p < a.geometry.length && !found; p++) {
        for (let q = 1; q < b.geometry.length && !found; q++) {
          found = segmentCrossing(a.geometry[p - 1], a.geometry[p], b.geometry[q - 1], b.geometry[q]);
        }
      }
      if (found) points.push(found);
    }
  }
  for (const point of points) graph.nodeAt(point);
  return points.length;
}

/**
 * Planarise: every place one line meets another is a vertex on both.
 *
 * Two passes, because they feed each other. Vertices land on edges (snaps, T-junctions), and crossings
 * land between two sets of vertices (X-junctions); the crossing pass creates the nodes, and the vertex
 * pass behind it cuts the lines that own them - including a third line the crossing node happens to
 * sit on. Splitting an edge never moves geometry, so it can never create a new crossing, and the two
 * passes settle in one round.
 */
function planarize(graph, toleranceM) {
  const tol = isNum(toleranceM) ? toleranceM : graph.joinToleranceM;
  let splits = splitAtInteriorVertices(graph, tol);
  const crossings = joinCrossings(graph);
  // No crossing means no new node for the vertex pass to cut, so the second pass is skipped: a graph
  // that only had T-junctions costs exactly what it cost before crossings were understood.
  if (crossings) splits += crossings + splitAtInteriorVertices(graph, tol);
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

// ---------------------------------------------------------------- protected (diverse) legs

function nodePoint(graph, nodeId) {
  const node = graph.nodes.get(nodeId);
  return { lat: node.lat, lon: node.lon };
}

/** Every arc of the graph in both directions, grouped by start node, sorted by edge id. */
function allArcs(graph) {
  const byNode = new Map();
  for (const id of graph.nodes.keys()) byNode.set(id, []);
  for (const edgeId of Array.from(graph.edges.keys()).sort(cmp)) {
    const edge = graph.edges.get(edgeId);
    byNode.get(edge.a).push({ to: edge.b, edgeId: edgeId, dir: 0, cost: edge.lengthM });
    byNode.get(edge.b).push({ to: edge.a, edgeId: edgeId, dir: 1, cost: edge.lengthM });
  }
  return byNode;
}

/**
 * Dijkstra over an arc map that carries its own costs (the residual graph's costs are not
 * `edge.lengthM`). Returns `{ arcs, cost }` or null when `toId` is unreachable.
 */
function shortestArcs(graph, byNode, fromId, toId) {
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) return null;
  const dist = new Map();
  const arrive = new Map();
  const visited = new Set();
  const order = Array.from(graph.nodes.keys()).sort(cmp);
  for (const id of order) dist.set(id, Infinity);
  dist.set(fromId, 0);

  while (true) {
    let current = null;
    let best = Infinity;
    for (const id of order) {
      if (visited.has(id)) continue;
      const d = dist.get(id);
      if (d < best - 1e-9) { best = d; current = id; }
    }
    if (current === null) break;
    if (current === toId) break;
    visited.add(current);
    const arcs = (byNode.get(current) || []).slice().sort(function (x, y) {
      return cmp(x.edgeId + ':' + x.dir, y.edgeId + ':' + y.dir);
    });
    for (const arc of arcs) {
      const candidate = dist.get(current) + arc.cost;
      if (candidate < dist.get(arc.to) - 1e-9) {
        dist.set(arc.to, candidate);
        arrive.set(arc.to, { from: current, edgeId: arc.edgeId, dir: arc.dir, cost: arc.cost });
      }
    }
  }
  if (!isFinite(dist.get(toId))) return null;

  const arcs = [];
  let cursor = toId;
  const guard = new Set();
  while (cursor !== fromId) {
    if (guard.has(cursor)) throw new Error('cycle in a shortest-path search at ' + cursor);
    guard.add(cursor);
    const step = arrive.get(cursor);
    if (!step) return null;
    arcs.push({ from: step.from, to: cursor, edgeId: step.edgeId, dir: step.dir, cost: step.cost });
    cursor = step.from;
  }
  arcs.reverse();
  return { arcs: arcs, cost: dist.get(toId) };
}

/** Turn a continuous arc chain into `{ nodes, edges, lengthM, route }`. */
function legFromArcs(graph, fromId, arcs) {
  const nodes = [fromId];
  const edges = [];
  const route = [];
  let lengthM = 0;
  let cursor = fromId;
  for (const arc of arcs) {
    if (arc.from !== cursor) throw new Error('the routed leg is not continuous at ' + cursor);
    const edge = graph.edges.get(arc.edgeId);
    const points = edge.a === arc.from ? edge.geometry : edge.geometry.slice().reverse();
    for (const point of points) {
      const last = route[route.length - 1];
      if (!last || last.lat !== point.lat || last.lon !== point.lon) {
        route.push({ lat: point.lat, lon: point.lon });
      }
    }
    edges.push({
      edgeId: edge.id,
      from: arc.from,
      to: arc.to,
      lengthM: round(edge.lengthM, 2),
      fromPoint: nodePoint(graph, arc.from),
      toPoint: nodePoint(graph, arc.to)
    });
    lengthM += edge.lengthM;
    cursor = arc.to;
    nodes.push(arc.to);
  }
  return { nodes: nodes, edges: edges, lengthM: round(lengthM, 2), route: route };
}

/** First path found over a pool of arcs (breadth-first, so it is deterministic), or null. */
function pathOverArcs(arcs, fromId, toId) {
  const byNode = new Map();
  for (const arc of arcs) {
    if (!byNode.has(arc.from)) byNode.set(arc.from, []);
    byNode.get(arc.from).push(arc);
  }
  for (const list of byNode.values()) {
    list.sort(function (a, b) { return cmp(a.edgeId + ':' + a.dir, b.edgeId + ':' + b.dir); });
  }
  const prev = new Map();
  prev.set(fromId, null);
  const queue = [fromId];
  while (queue.length) {
    const node = queue.shift();
    if (node === toId) break;
    for (const arc of byNode.get(node) || []) {
      if (prev.has(arc.to)) continue;
      prev.set(arc.to, { arc: arc, from: node });
      queue.push(arc.to);
    }
  }
  if (!prev.has(toId)) return null;
  const path = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = prev.get(cursor);
    path.push(step.arc);
    cursor = step.from;
  }
  return path.reverse();
}

function legOrderKey(leg) {
  return leg.lengthM.toFixed(3) + '|' + leg.edges.map(function (e) { return e.edgeId; }).join(',');
}

/** Legs are ordered by length then by edge-id sequence: a re-run cannot swap them. */
function orderLegs(legs) {
  return legs.slice().sort(function (a, b) { return cmp(legOrderKey(a), legOrderKey(b)); });
}

/**
 * Two legs between the same pair of nodes, as diverse as the graph allows.
 *
 * Suurballe's algorithm: find the shortest path, reverse its arcs at negative cost, find the shortest
 * path in that residual graph (Johnson potentials, taken from the first shortest-path tree, keep every
 * residual cost non-negative), then cancel the arcs the two searches used in opposite directions. What
 * is left decomposes into two edge-disjoint paths - and only then does "protected" mean anything.
 *
 * A ring gives two legs of half the ring each and 0 m shared. When the graph offers no second route at
 * all (one corridor into the building, the normal case), falling back to "two shortest paths" would
 * have returned the SAME path twice and called it diverse, so the fallback is instead the cheapest path
 * that minimises *shared metres* (shared edges carry a penalty larger than the whole network) and the
 * shared segments are returned by name with their metres. "Diverse until the last duct" is a real
 * answer and it is printed, not hidden.
 *
 * Returns null when the graph does not connect the two nodes at all.
 */
function diversePaths(graph, fromId, toId, opts) {
  const o = opts || {};
  if (!graph || !graph.nodes.has(fromId) || !graph.nodes.has(toId)) return null;
  if (fromId === toId) throw new Error('a link needs two different points on the network');

  const first = shortestArcs(graph, allArcs(graph), fromId, toId);
  if (!first) return null;

  const usedByFirst = new Map();
  for (const arc of first.arcs) usedByFirst.set(arc.edgeId, arc.dir);

  // Residual graph. A first-path arc is only available reversed and at negative cost; every other
  // edge is available both ways. Potentials h() are the first-path distances.
  const tree = dijkstra(graph, fromId);
  const residual = new Map();
  for (const id of graph.nodes.keys()) residual.set(id, []);
  function pushResidual(edge, dir, cost) {
    const from = dir === 0 ? edge.a : edge.b;
    const to = dir === 0 ? edge.b : edge.a;
    const hFrom = tree.dist.get(from);
    const hTo = tree.dist.get(to);
    if (!isFinite(hFrom) || !isFinite(hTo)) return;
    residual.get(from).push({ to: to, edgeId: edge.id, dir: dir, cost: cost + hFrom - hTo });
  }
  for (const edgeId of Array.from(graph.edges.keys()).sort(cmp)) {
    const edge = graph.edges.get(edgeId);
    if (usedByFirst.has(edgeId)) {
      pushResidual(edge, 1 - usedByFirst.get(edgeId), -edge.lengthM);
    } else {
      pushResidual(edge, 0, edge.lengthM);
      pushResidual(edge, 1, edge.lengthM);
    }
  }

  const second = shortestArcs(graph, residual, fromId, toId);
  if (second) {
    // Cancel arcs the two searches used in opposite directions.
    const byEdge = new Map();
    for (const arc of first.arcs.concat(second.arcs)) {
      if (!byEdge.has(arc.edgeId)) byEdge.set(arc.edgeId, []);
      byEdge.get(arc.edgeId).push(arc);
    }
    const pool = [];
    for (const edgeId of Array.from(byEdge.keys()).sort(cmp)) {
      const group = byEdge.get(edgeId);
      if (group.length === 2 && group[0].dir !== group[1].dir) continue;
      pool.push(group[0]);
    }
    const firstLeg = pathOverArcs(pool, fromId, toId);
    if (firstLeg) {
      const rest = pool.filter(function (arc) { return firstLeg.indexOf(arc) === -1; });
      const secondLeg = pathOverArcs(rest, fromId, toId);
      if (secondLeg) {
        const legs = orderLegs([
          legFromArcs(graph, fromId, firstLeg),
          legFromArcs(graph, fromId, secondLeg)
        ]);
        const seen = new Set();
        let disjoint = true;
        for (const leg of legs) {
          for (const edge of leg.edges) {
            if (seen.has(edge.edgeId)) disjoint = false;
            seen.add(edge.edgeId);
          }
        }
        if (disjoint) {
          return { legs: legs, shared: [], sharedM: 0, disjoint: true, method: 'suurballe' };
        }
      }
    }
  }

  // No edge-disjoint pair exists. Take the cheapest path that shares the fewest metres with the first
  // one: a shared edge costs more than the entire network, so the search avoids sharing before it
  // shortens itself.
  let totalM = 0;
  for (const edge of graph.edges.values()) totalM += edge.lengthM;
  const weighted = allArcs(graph);
  for (const list of weighted.values()) {
    for (const arc of list) if (usedByFirst.has(arc.edgeId)) arc.cost += totalM + 1;
  }
  const alternate = shortestArcs(graph, weighted, fromId, toId);
  if (!alternate) {
    return { legs: [legFromArcs(graph, fromId, first.arcs)], shared: [], sharedM: 0, disjoint: false, method: 'single-route' };
  }

  const alternateEdges = new Set(alternate.arcs.map(function (a) { return a.edgeId; }));
  const shared = [];
  let sharedM = 0;
  for (const arc of first.arcs) {
    if (!alternateEdges.has(arc.edgeId)) continue;
    const edge = graph.edges.get(arc.edgeId);
    shared.push({
      kind: 'duct',
      edgeId: edge.id,
      lengthM: round(edge.lengthM, 2),
      from: nodePoint(graph, arc.from),
      to: nodePoint(graph, arc.to),
      route: edge.a === arc.from ? edge.geometry.slice() : edge.geometry.slice().reverse()
    });
    sharedM += edge.lengthM;
  }

  return {
    legs: orderLegs([legFromArcs(graph, fromId, first.arcs), legFromArcs(graph, fromId, alternate.arcs)]),
    shared: shared,
    sharedM: round(sharedM, 2),
    disjoint: sharedM === 0,
    method: o.method || 'fewest-shared-metres'
  };
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
  routePath: routePath,
  diversePaths: diversePaths
};
