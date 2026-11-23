'use strict';
/**
 * The plant: OLT -> feeder -> closures and splitters -> drop -> ONT.
 *
 * A design is a tree, not a graph. Every ONT has exactly one path back to one PON port, and that
 * path is what a power budget, a splice diagram and a cable order are all derived from. Making the
 * tree explicit (and refusing cycles) is what keeps those three numbers describing the same network.
 *
 *   nodes: [{ id, type: 'olt'|'closure'|'splitter'|'ont', model?, name, lat?, lon? }]
 *   spans: [{ id, from, to, cable, lengthM, strands?: [1, 7], splices?: n, closures?: n }]
 *
 * `spans[].strands` are the strand indices **in use** on that span (1-based, as `fiber.js` numbers
 * them). Omit it and the span carries nothing: spare capacity, not zero capacity.
 */

const budget = require('./budget');
const fiber = require('./fiber');

const NODE_TYPES = ['olt', 'headend', 'closure', 'splitter', 'ont'];

// The root of the plant: a PON's OLT, or the aggregation point of an active network. Exactly one,
// and its type decides how every path under it is budgeted.
const ROOT_TYPES = ['olt', 'headend'];

/**
 * The plant-level root rule, stated once.
 *
 * Two OLTs is not a design with a spare - it is two designs in one file. Everything the engine
 * derives (the path, the cascade, the port count) would silently be about whichever root happened to
 * be found first, so the count is checked rather than guessed, and the count is quoted so the fault
 * cannot be mistaken for one customer's problem.
 */
function rootCountMessage(found) {
  return 'exactly one olt or headend node is required, found ' + found;
}

function rootNodes(plant) {
  return ((plant && plant.nodes) || []).filter(function (n) { return n && ROOT_TYPES.indexOf(n.type) !== -1; });
}

/**
 * Which catalogue kinds a node's `model` may name.
 *
 * A customer endpoint is an `ont` on a PON and a `transceiver` on an active network - same node type,
 * different hardware - because "the thing at the house" is one concept in the plant and two kinds in
 * the catalogue. Resolution goes by what the model actually is, never by assuming the type implies it.
 */
const MODEL_KINDS = {
  olt: ['olt'],
  headend: ['transceiver'],
  splitter: ['splitter'],
  ont: ['ont', 'transceiver'],
  closure: ['closure']
};

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function nodeById(plant, id) {
  return (plant.nodes || []).find(function (n) { return n.id === id; }) || null;
}

function adjacency(plant) {
  const adj = new Map();
  for (const node of plant.nodes || []) adj.set(node.id, []);
  for (const span of plant.spans || []) {
    if (adj.has(span.from)) adj.get(span.from).push({ span: span, to: span.to });
    if (adj.has(span.to)) adj.get(span.to).push({ span: span, to: span.from });
  }
  return adj;
}

/**
 * The path from the OLT to one ONT.
 *
 * Depth-first from the single OLT node, carrying the trail. A node reached twice is a cycle and the
 * caller is told so rather than being handed one arbitrary path.
 */
function trace(plant, ontId) {
  if (!plant || !Array.isArray(plant.nodes) || !Array.isArray(plant.spans)) {
    throw new TypeError('trace needs a plant object with nodes and spans');
  }
  const target = nodeById(plant, ontId);
  if (!target) throw new Error('no node with id "' + ontId + '"');
  if (target.type !== 'ont') throw new Error('node "' + ontId + '" is a ' + target.type + ', not an ont');

  const roots = plant.nodes.filter(function (n) { return ROOT_TYPES.indexOf(n.type) !== -1; });
  if (roots.length !== 1) {
    throw new Error('a plant needs exactly one olt (or headend) node, found ' + roots.length);
  }
  const root = roots[0];

  const adj = adjacency(plant);
  const visited = new Set();
  const trail = [];

  function walk(id) {
    if (visited.has(id)) return false;
    visited.add(id);
    if (id === ontId) return true;
    for (const edge of adj.get(id) || []) {
      trail.push(edge);
      if (walk(edge.to)) return true;
      trail.pop();
    }
    return false;
  }

  if (!walk(root.id)) throw new Error('ont "' + ontId + '" is not connected to the head-end');

  const nodes = [root];
  const spans = [];
  let cursor = root.id;
  for (const edge of trail) {
    spans.push(edge.span);
    const next = nodeById(plant, edge.to);
    nodes.push(next);
    cursor = next.id;
  }
  if (cursor !== ontId) throw new Error('internal error: trail ended at "' + cursor + '", not "' + ontId + '"');

  return { nodes: nodes, spans: spans };
}

/**
 * Turn a traced path into a budget design.
 *
 * The modelling choices, stated because they are choices:
 * - one splice per closure the thread passes through (a through-splice at each end of the closure);
 * - one splice on the input side of a splitter whose spec says `termination: "spliced"`, and two
 *   connectors on it when the spec says `connectorised`;
 * - one connector at the OLT port and one at the ONT;
 * - fibre loss from every span's own cable spec and measured length.
 */
function designForOnt(plant, ontId, registry, opts) {
  const o = opts || {};
  const path = trace(plant, ontId);
  const spans = path.spans.map(function (s) { return { cable: s.cable, lengthM: s.lengthM }; });
  const splitters = [];
  let splices = 0;
  let connectors = 2;
  const notes = [];

  for (const node of path.nodes) {
    if (node.type === 'closure') {
      splices += 1;
      if (node.model) {
        const closure = registry.has('closure', node.model) ? registry.get('closure', node.model) : null;
        if (closure && closure.spliceCapacity && splices > closure.spliceCapacity) {
          notes.push('closure "' + node.name + '" would carry ' + splices + ' splices, capacity ' + closure.spliceCapacity);
        }
      }
    } else if (node.type === 'splitter') {
      if (!node.model) throw new Error('splitter node "' + node.id + '" has no model');
      const part = registry.get('splitter', node.model);
      splitters.push({ model: part.model });
      if (part.termination === 'connectorised') connectors += 2;
      else splices += 1;
    }
  }

  const root = path.nodes[0];
  const endNode = nodeById(plant, ontId);
  const common = {
    direction: o.direction || 'down',
    wavelength: o.wavelength,
    spans: spans,
    splices: splices,
    connectors: connectors,
    connectorModel: o.connectorModel,
    spliceModel: o.spliceModel,
    allowanceDb: o.allowanceDb,
    marginDb: o.marginDb
  };

  let result;
  if (root.type === 'headend') {
    // Active network: the customer end is an optic, not an ONT, and there are no splitters on the
    // path (validate refuses them). The budget is the optic pair's, not a PON class.
    if (!root.model) throw new Error('the headend node has no model');
    if (!endNode.model) throw new Error('ont "' + ontId + '" has no model');
    if (!registry.has('transceiver', endNode.model)) {
      throw new Error('ont "' + ontId + '" is a ' + endNode.model + ', which is not a transceiver - an active network needs optics at both ends');
    }
    const design = Object.assign({}, common, {
      headEnd: { model: root.model },
      cpe: { model: endNode.model }
    });
    result = budget.pointToPoint(design, registry);
  } else {
    const design = Object.assign({}, common, {
      olt: { model: root.model },
      ont: { model: endNode.model },
      splitters: splitters
    });
    if (!design.olt.model) throw new Error('the olt node has no model');
    if (!design.ont.model) throw new Error('ont "' + ontId + '" has no model');
    result = budget.opticalBudget(design, registry);
  }

  result.path = path.nodes.map(function (n) { return { id: n.id, type: n.type, name: n.name }; });
  result.notes = notes;
  return result;
}

/** Every ONT's budget, in one pass. This is the "signal" page of the planner. */
function allOntBudgets(plant, registry, opts) {
  const onts = (plant.nodes || []).filter(function (n) { return n.type === 'ont'; });
  return onts.map(function (node) {
    try {
      return { ont: node.id, name: node.name, result: designForOnt(plant, node.id, registry, opts) };
    } catch (err) {
      return { ont: node.id, name: node.name, error: err.message };
    }
  });
}

/**
 * Strand accounting per span.
 *
 * Overbooking is the failure this exists to catch: a 12-fibre cable with 14 strands assigned to it
 * is not a drawing with a red pixel, it is a cable somebody will order and not be able to splice.
 */
function strandLedger(plant, registry) {
  const rows = [];
  let totalStrands = 0;
  let totalUsed = 0;

  (plant.spans || []).forEach(function (span, i) {
    let cable = null;
    if (registry.has('cable', span.cable)) cable = registry.get('cable', span.cable);
    const strands = Array.isArray(span.strands) ? span.strands.slice() : [];
    const unique = new Set(strands);
    const used = unique.size;
    const fiberCount = cable ? cable.fiberCount : null;
    const row = {
      span: span.id || '#' + i,
      cable: span.cable,
      fiberCount: fiberCount,
      used: used,
      spare: fiberCount === null ? null : Math.max(0, fiberCount - used),
      utilisation: fiberCount ? Math.round((used / fiberCount) * 1000) / 10 : null,
      overbooked: fiberCount !== null && used > fiberCount
    };
    if (row.overbooked) row.error = 'span "' + row.span + '" uses ' + used + ' strands of a ' + fiberCount + '-fibre cable';
    rows.push(row);
    if (fiberCount !== null) totalStrands += fiberCount;
    totalUsed += used;
  });

  return {
    rows: rows,
    totalStrands: totalStrands,
    totalUsed: totalUsed,
    utilisation: totalStrands ? Math.round((totalUsed / totalStrands) * 1000) / 10 : 0,
    overbooked: rows.filter(function (r) { return r.overbooked; }).length
  };
}

/** Capacity of the plant against the OLT's own limits: ports, split ratio, ONTs per port. */
function capacity(plant, registry) {
  const onts = (plant.nodes || []).filter(function (n) { return n.type === 'ont'; });
  const splitters = (plant.nodes || []).filter(function (n) { return n.type === 'splitter'; });
  const roots = rootNodes(plant);
  if (roots.length !== 1) {
    // Refuse to pick a root. Reporting the first OLT's ports for a plant that has two of them (or
    // none yet) would let an ambiguous plant read as healthy: `stats` and `project.summary` run on
    // projects that were never validated, and the signal page prints this next to the ONT count.
    return {
      technology: null,
      olt: null,
      headend: null,
      ports: null,
      maxSplitRatio: null,
      onts: onts.length,
      splitters: splitters.length,
      splitterCascade: 1,
      theoreticalMaxOnts: null,
      problems: ['capacity needs exactly one olt/headend root, found ' + roots.length]
    };
  }
  const root = roots[0];
  const oltNode = root.type === 'olt' ? root : null;
  const headendNode = root.type === 'headend' ? root : null;

  if (!oltNode && headendNode) {
    // An active network's limit is the aggregation switch's port count and its uplink budget, neither
    // of which this model carries: a transceiver is an optic, not a chassis. Say so rather than
    // inventing a ceiling of one.
    return {
      technology: 'active',
      headend: headendNode.model || null,
      ports: null,
      maxSplitRatio: null,
      onts: onts.length,
      splitters: 0,
      splitterCascade: 1,
      theoreticalMaxOnts: null,
      problems: []
    };
  }

  const olt = oltNode && oltNode.model && registry.has('olt', oltNode.model) ? registry.get('olt', oltNode.model) : null;

  // The deepest cascade is the worst *path*, not the product of every splitter in the plant.
  // Multiplying them all turned six 1:8 splitters at six different sites into a 1:262144 cascade that
  // no ONT was actually behind - and refused a perfectly good PON design.
  let maxCascade = 1;
  {
    const adj = adjacency(plant);
    const oltOrHead = (plant.nodes || []).find(function (n) {
      return n.type === 'olt' || n.type === 'headend';
    });
    const stack = oltOrHead ? [{ id: oltOrHead.id, ratio: 1, seen: new Set([oltOrHead.id]) }] : [];
    while (stack.length) {
      const step = stack.pop();
      const node = (plant.nodes || []).find(function (n) { return n.id === step.id; });
      let ratio = step.ratio;
      if (node && node.type === 'splitter' && node.model && registry.has('splitter', node.model)) {
        ratio *= registry.get('splitter', node.model).ratio;
        if (ratio > maxCascade) maxCascade = ratio;
      }
      for (const edge of adj.get(step.id) || []) {
        if (step.seen.has(edge.to)) continue;
        const next = new Set(step.seen);
        next.add(edge.to);
        stack.push({ id: edge.to, ratio: ratio, seen: next });
      }
    }
  }

  const ports = olt ? olt.ports : null;
  const limitRatio = olt ? olt.maxSplitRatio : null;
  const theoreticalMax = ports && limitRatio ? ports * limitRatio : null;

  const problems = [];
  if (olt && maxCascade > limitRatio) {
    problems.push('the deepest splitter cascade is 1:' + maxCascade + ', beyond the ' + olt.model + ' limit of 1:' + limitRatio);
  }
  if (theoreticalMax !== null && onts.length > theoreticalMax) {
    problems.push(onts.length + ' ONTs exceed ' + ports + ' ports x 1:' + limitRatio + ' = ' + theoreticalMax);
  }

  return {
    technology: 'pon',
    olt: olt ? olt.model : null,
    ports: ports,
    maxSplitRatio: limitRatio,
    onts: onts.length,
    splitters: splitters.length,
    splitterCascade: maxCascade,
    theoreticalMaxOnts: theoreticalMax,
    problems: problems
  };
}

/** Structural validation. Errors refuse a save; warnings are the things a planner should look at. */
function validate(plant, registry) {
  const errors = [];
  const warnings = [];

  if (!plant || typeof plant !== 'object') return { ok: false, errors: ['plant is not an object'], warnings: warnings };
  const nodes = Array.isArray(plant.nodes) ? plant.nodes : null;
  const spans = Array.isArray(plant.spans) ? plant.spans : null;
  if (!nodes) errors.push('nodes must be an array');
  if (!spans) errors.push('spans must be an array');
  if (errors.length) return { ok: false, errors: errors, warnings: warnings };

  const ids = new Set();
  for (const node of nodes) {
    if (!node || !node.id) { errors.push('a node has no id'); continue; }
    if (ids.has(node.id)) errors.push('duplicate node id "' + node.id + '"');
    ids.add(node.id);
    if (NODE_TYPES.indexOf(node.type) === -1) {
      errors.push('node "' + node.id + '" has unknown type "' + node.type + '"');
      continue;
    }
    const allowed = MODEL_KINDS[node.type] || [];
    if (allowed.length) {
      if (!node.model) {
        if (node.type !== 'closure') errors.push(node.type + ' node "' + node.id + '" has no model');
      } else if (!allowed.some(function (k) { return registry.has(k, node.model); })) {
        const message = 'node "' + node.id + '" uses unknown ' + allowed.join('/') + ' model "' + node.model + '"';
        if (node.type === 'closure') warnings.push(message);
        else errors.push(message);
      }
    }
    // `null` means "not placed on a map yet", which is a legitimate state for a node added from the
    // palette. Only a present-but-wrong value is an error.
    if (node.lat !== undefined && node.lat !== null && (typeof node.lat !== 'number' || !isFinite(node.lat) || Math.abs(node.lat) > 90)) {
      errors.push('node "' + node.id + '" has an invalid latitude');
    }
    if (node.lon !== undefined && node.lon !== null && (typeof node.lon !== 'number' || !isFinite(node.lon) || Math.abs(node.lon) > 180)) {
      errors.push('node "' + node.id + '" has an invalid longitude');
    }
  }

  const roots = nodes.filter(function (n) { return n && ROOT_TYPES.indexOf(n.type) !== -1; });
  if (roots.length !== 1) {
    errors.push(rootCountMessage(roots.length));
  } else {
    const active = roots[0].type === 'headend';
    if (active && nodes.some(function (n) { return n.type === 'splitter'; })) {
      errors.push('an active network (headend root) cannot contain a splitter - splitters are a PON element');
    }
    if (!active && nodes.some(function (n) {
      return n.type === 'ont' && n.model && registry.has('transceiver', n.model) && !registry.has('ont', n.model);
    })) {
      errors.push('a PON plant needs ONT models at the customer end, not transceivers');
    }
  }
  // From here the root count is either exactly one or already an error, and the per-ONT pass further
  // down lives inside `if (!errors.length)`. That ordering is what keeps a root-count fault a *plant*
  // fault: no customer ONT can ever be blamed for it, so the message a caller greps for is unambiguous.

  const spanIds = new Set();
  for (const span of spans) {
    if (!span || !span.id) { errors.push('a span has no id'); continue; }
    if (spanIds.has(span.id)) errors.push('duplicate span id "' + span.id + '"');
    spanIds.add(span.id);
    if (!ids.has(span.from)) errors.push('span "' + span.id + '" starts at unknown node "' + span.from + '"');
    if (!ids.has(span.to)) errors.push('span "' + span.id + '" ends at unknown node "' + span.to + '"');
    if (span.from === span.to) errors.push('span "' + span.id + '" connects a node to itself');
    if (!span.cable) errors.push('span "' + span.id + '" has no cable model');
    else if (!registry.has('cable', span.cable)) errors.push('span "' + span.id + '" uses unknown cable model "' + span.cable + '"');
    if (!isNum(span.lengthM) || span.lengthM <= 0) errors.push('span "' + span.id + '" has no measured length');
    if (span.lengthM > 20000) warnings.push('span "' + span.id + '" is over 20 km - is the length in metres?');
  }

  if (!errors.length) {
    // Connectivity and cycles, from the OLT outward.
    const adj = adjacency(plant);
    const seen = new Set();
    let stack = roots.map(function (n) { return n.id; });
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of adj.get(id) || []) stack.push(edge.to);
    }
    for (const node of nodes) {
      if (!seen.has(node.id)) warnings.push('node "' + node.id + '" is not connected to the head-end');
    }
    const edges = spans.reduce(function (n, s) { return n + 1; }, 0);
    if (edges !== Math.max(0, nodes.length - 1)) {
      warnings.push('a tree of ' + nodes.length + ' nodes should have ' + Math.max(0, nodes.length - 1) + ' spans, found ' + edges + ' (a cycle or an isolated node)');
    }

    for (const node of nodes) {
      if (node.type !== 'ont') continue;
      // An ONT that is not connected yet is a design in progress, not a contradiction: it already
      // gets the "not connected" warning above, and refusing the save would lose the rest of the
      // drawing. It is the *budget* that fails loudly for it, on the signal page.
      if (!seen.has(node.id)) continue;
      try {
        const path = trace(plant, node.id);
        const last = path.spans[path.spans.length - 1];
        const label = node.name || node.id;
        if (last && last.lengthM > 500) warnings.push('drop to "' + label + '" is ' + last.lengthM + ' m - check the run');
      } catch (err) {
        errors.push('ont "' + node.id + '": ' + err.message);
      }
    }

    const cap = capacity(plant, registry);
    cap.problems.forEach(function (p) { errors.push(p); });

    (plant.nodes || []).forEach(function (node) {
      if (node.type !== 'closure' || !node.model || !registry.has('closure', node.model)) return;
      const closure = registry.get('closure', node.model);
      const touching = spans.filter(function (s) { return s.from === node.id || s.to === node.id; }).length;
      if (closure.ports && touching > closure.ports) {
        warnings.push('closure "' + (node.name || node.id) + '" has ' + touching + ' cables into ' + closure.ports + ' ports');
      }
    });
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

function stats(plant, registry) {
  const spans = plant.spans || [];
  const routeM = spans.reduce(function (n, s) { return n + (isNum(s.lengthM) ? s.lengthM : 0); }, 0);
  return {
    nodes: (plant.nodes || []).length,
    spans: spans.length,
    onts: (plant.nodes || []).filter(function (n) { return n.type === 'ont'; }).length,
    splitters: (plant.nodes || []).filter(function (n) { return n.type === 'splitter'; }).length,
    closures: (plant.nodes || []).filter(function (n) { return n.type === 'closure'; }).length,
    routeM: Math.round(routeM * 10) / 10,
    routeKm: Math.round((routeM / 1000) * 1000) / 1000,
    capacity: capacity(plant, registry),
    strands: strandLedger(plant, registry)
  };
}


/**
 * The splice schedule: for every splice point (a closure or a splitter), the strands arriving on each
 * cable and which strand on the other side each one is joined to.
 *
 * This is what a crew works from on paper, and it is derived from the same `span.strands` the strand
 * ledger and the canvas address. A strand that arrives on a single cable is parked, not spliced, and
 * its `splicedTo` is empty - saying so is the point: an empty list is a decision, not a missing row.
 * Indices that are not positive integers are skipped, so one bad hand-edited project cannot make the
 * print page die.
 */
function spliceTable(plant, registry) {
  const nodes = (plant && plant.nodes) || [];
  const spans = (plant && plant.spans) || [];
  const idOf = new Map();
  spans.forEach(function (span, i) { idOf.set(span, span.id || '#' + i); });

  const points = [];
  let totalStrands = 0;

  for (const node of nodes) {
    if (node.type !== 'closure' && node.type !== 'splitter') continue;
    const local = spans.filter(function (s) { return s.from === node.id || s.to === node.id; });
    const byStrand = new Map();
    for (const span of local) {
      const seen = new Set();
      for (const raw of Array.isArray(span.strands) ? span.strands : []) {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 1) continue;
        if (seen.has(index)) continue;
        seen.add(index);
        const list = byStrand.get(index) || [];
        list.push(idOf.get(span));
        byStrand.set(index, list);
      }
    }
    if (!byStrand.size) continue;

    const rows = [];
    Array.from(byStrand.keys()).sort(function (a, b) { return a - b; }).forEach(function (index) {
      const carriers = byStrand.get(index).slice().sort();
      const address = fiber.addressFor(index);
      carriers.forEach(function (spanId) {
        rows.push({
          span: spanId,
          strand: index,
          address: address.label,
          colour: address.fiberColor.name,
          hex: address.fiberColor.hex,
          splicedTo: carriers.filter(function (id) { return id !== spanId; })
        });
      });
    });
    totalStrands += rows.length;
    points.push({
      node: node.id,
      name: node.name || node.id,
      type: node.type,
      model: node.model || null,
      spans: local.map(function (s) { return idOf.get(s); }),
      rows: rows
    });
  }

  return { points: points, totalStrands: totalStrands };
}

module.exports = {
  NODE_TYPES: NODE_TYPES,
  trace: trace,
  designForOnt: designForOnt,
  allOntBudgets: allOntBudgets,
  strandLedger: strandLedger,
  spliceTable: spliceTable,
  capacity: capacity,
  validate: validate,
  stats: stats
};
