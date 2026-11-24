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

/**
 * A splice or closure count on a span.
 *
 * Absent means none - the design builders omit the field on a span with nothing to count - so
 * `undefined` is valid and the BOM reads it as 0. Otherwise it is a non-negative whole number, or a
 * list of splices, which the BOM counts by its length. Text, a negative, a fraction and `null` are
 * not priceable: `cableToBuy` throws its own sentence for them, and at `/bom` that sentence arrives
 * as a 500 blaming the server for the caller's field. Refused here instead, by span and by field.
 */
function isSpanCount(value) {
  if (value === undefined) return true;
  return Array.isArray(value) || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/**
 * How many cables run a span.
 *
 * A span is one route but not always one cable: auto-design sets `bundles` when the fibres it has to
 * carry do not fit the largest cable in the ladder, so a 160-fibre trunk is two 144-fibre cables over
 * the same measured route. Absent means one cable. Zero is not a cable count - it would buy no cable
 * for a span that is drawn on the map - and a fraction is not one either, so both are refused by name
 * rather than read as one.
 */
function isBundleCount(value) {
  if (value === undefined) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

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
  // Quote the types rather than splicing one into a fixed article: "is a " + "olt" reads "a olt",
  // and the server's own 400 says `has type "olt", not "ont" - /budget takes an ONT id`. Same sentence
  // shape here so a direct engine caller and an allOntBudgets error row carry the same wording.
  if (target.type !== 'ont') {
    throw new Error('node "' + ontId + '" has type "' + target.type + '", not "ont" - trace takes an ONT id');
  }

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
/**
 * How many splices a closure on a traced path holds.
 *
 * A through-splice joins what both cable ends carry, so the tray count is the smaller of the
 * cables meeting the box, and the one cable touching it at the end of a path. That is why the last
 * handhole on a feeder fed by 12 fibres and closed by one drop holds one splice, not twelve.
 * A strand's own loss is a separate question and stays one splice per closure (see `designForOnt`).
 */
function splicesAtClosure(nodeId, spans, registry) {
  let smallest = null;
  for (const span of spans) {
    if (span.from !== nodeId && span.to !== nodeId) continue;
    const cable = registry.has('cable', span.cable) ? registry.get('cable', span.cable) : null;
    if (!cable || !isNum(cable.fiberCount)) continue;
    if (smallest === null || cable.fiberCount < smallest) smallest = cable.fiberCount;
  }
  return smallest === null ? 0 : smallest;
}

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
        // The box holds one splice per strand it joins, so the question is how many fibres pass
        // through *this* closure - not how many splices the whole path has made by the time it
        // arrives. A cumulative counter told the thirteenth handhole on a feeder that it carried
        // thirteen splices when it carried twelve, and it could never see a 48-fibre cable dragged
        // through a 12-splice box. Warnings that are wrong in both directions stop being read.
        const inThisClosure = splicesAtClosure(node.id, path.spans, registry);
        if (closure && closure.spliceCapacity && inThisClosure > closure.spliceCapacity) {
          notes.push('closure "' + node.name + '" would carry ' + inThisClosure + ' splices, capacity ' + closure.spliceCapacity);
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
    marginDb: o.marginDb,
    // The launch power is a design field, and this is the third place that has to pass it through:
    // without it `/budget {"txDbm":7}` budgeted at the OLT's minimum and echoed `txDbm: 3`, a 200
    // whose answer contradicted the request - the #161 defect one endpoint over. Absent stays absent;
    // the budget's own floor applies and is echoed.
    txDbm: o.txDbm
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

/**
 * One ONT's budget, in the row shape every caller of the budget endpoint receives.
 *
 * `{ ont, name, result }` on a link, `{ ont, name, error }` when the path cannot be budgeted at all,
 * and `ont` is always the **node id**. Stated once here because it was not: the endpoint's list form
 * answered this row, while its `ontId` form answered the bare `result` - no wrapper, `ont` holding
 * the ONT *model*, so a caller reading the documented `budgets[0].result` got `undefined`, and a
 * path that cannot be budgeted escaped the handler as a 500 while the list call reported the same
 * fault as an error row. Two shapes for one endpoint is a contract nobody can code against.
 */
function budgetRow(plant, ontId, registry, opts) {
  const node = nodeById(plant, ontId);
  const name = node ? (node.name === undefined ? null : node.name) : null;
  try {
    return { ont: ontId, name: name, result: designForOnt(plant, ontId, registry, opts) };
  } catch (err) {
    return { ont: ontId, name: name, error: err.message };
  }
}

/** Every ONT's budget, in one pass. This is the "signal" page of the planner. */
function allOntBudgets(plant, registry, opts) {
  const onts = (plant.nodes || []).filter(function (n) { return n.type === 'ont'; });
  return onts.map(function (node) { return budgetRow(plant, node.id, registry, opts); });
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
    // A span's `bundles` is how many cables run it, so its capacity is every cable's fibres: 18 strands
    // in use on a 2 x 12 span is three-quarters full, not overbooked, and a second cable's twelve
    // spare strands are on the order whether or not the ledger counted them.
    const bundles = span.bundles === undefined ? 1 : (isBundleCount(span.bundles) ? span.bundles : 1);
    const capacityFibres = fiberCount === null ? null : fiberCount * bundles;
    const row = {
      span: span.id || '#' + i,
      cable: span.cable,
      bundles: bundles,
      fiberCount: fiberCount,
      used: used,
      spare: capacityFibres === null ? null : Math.max(0, capacityFibres - used),
      utilisation: capacityFibres ? Math.round((used / capacityFibres) * 1000) / 10 : null,
      overbooked: capacityFibres !== null && used > capacityFibres
    };
    if (row.overbooked) {
      row.error = 'span "' + row.span + '" uses ' + used + ' strands of ' +
        (bundles > 1 ? bundles + ' x ' + fiberCount + '-fibre cable' : 'a ' + fiberCount + '-fibre cable');
    }
    rows.push(row);
    if (capacityFibres !== null) totalStrands += capacityFibres;
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

/** Capacity of the plant against the OLT's limits and each splitter's own: ports, split ratio, ONTs
 * per port, branches per splitter. */
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
      splitterPorts: [],
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
      splitterPorts: [],
      problems: []
    };
  }

  const olt = oltNode && oltNode.model && registry.has('olt', oltNode.model) ? registry.get('olt', oltNode.model) : null;

  // The deepest cascade is the worst *path*, not the product of every splitter in the plant.
  // Multiplying them all turned six 1:8 splitters at six different sites into a 1:262144 cascade that
  // no ONT was actually behind - and refused a perfectly good PON design.
  let maxCascade = 1;
  const adj = adjacency(plant);
  {
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

  // A splitter's own output ports, counted per site.
  //
  // A 1:8 cassette has eight outputs; a ninth customer behind it is a fibre with nowhere to go, and
  // the OLT-level checks above cannot see it: nine ONTs on one 1:8 site is a cascade of 8, inside any
  // maxSplitRatio, and 9 is inside ports x ratio too.
  //
  // Ports are counted in FIBRES, because that is what a port is: one cassette output feeds exactly one
  // fibre. Counting cabled outputs instead reported a splitter whose eight customers share one
  // distribution cable - the shape `emitTerminalTree` produces, one strand per ONT - as "1 of 8 ports
  // used", so a ninth customer added to that cable passed `validate`, budgeted `ok`, and went on the
  // bill of materials as a fibre nobody could light. The splice schedule had always numbered those
  // ports per strand (P1..P8 on that cable); the capacity view disagreed with it.
  //
  // So a walk from the splitter counts one output per ONT below it and one per downstream splitter,
  // where it stops: a downstream splitter spends one fibre and its own ports are counted at its site -
  // the mistake the cascade rule already exists to avoid, one level down. A strand merely listed on a
  // cable with no ONT behind it is spare, not an output in use, and costs nothing. A node that is
  // drawn but never connected to the root is not behind the splitter at all, keeps its own "not
  // connected" warning from `validate`, and is not charged to a port here.
  const splitterPorts = [];
  {
    const parentOf = new Map();
    const seen = new Set();
    const stack = [root.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of adj.get(id) || []) {
        if (seen.has(edge.to) || parentOf.has(edge.to)) continue;
        parentOf.set(edge.to, id);
        stack.push(edge.to);
      }
    }
    const children = new Map();
    for (const [child, parent] of parentOf) {
      const list = children.get(parent) || [];
      list.push(child);
      children.set(parent, list);
    }
    const typeOf = new Map((plant.nodes || []).map(function (n) { return [n.id, n.type]; }));
    // Outputs in use, in fibres: an ONT is one, a downstream splitter is one and ends the walk.
    const outputsInUse = function (splitterId) {
      const walked = new Set([splitterId]);
      const pending = (children.get(splitterId) || []).slice();
      let used = 0;
      while (pending.length) {
        const id = pending.pop();
        if (walked.has(id)) continue;
        walked.add(id);
        const type = typeOf.get(id) || null;
        if (type === 'ont' || type === 'splitter') { used += 1; continue; }
        for (const child of children.get(id) || []) pending.push(child);
      }
      return used;
    };
    for (const node of plant.nodes || []) {
      if (node.type !== 'splitter' || !node.model || !registry.has('splitter', node.model)) continue;
      const part = registry.get('splitter', node.model);
      const used = outputsInUse(node.id);
      splitterPorts.push({
        node: node.id,
        name: node.name || node.id,
        model: part.model,
        ratio: part.ratio,
        portsUsed: used,
        overbooked: used > part.ratio
      });
    }
  }

  const ports = olt ? olt.ports : null;
  const limitRatio = olt ? olt.maxSplitRatio : null;
  const theoreticalMax = ports && limitRatio ? ports * limitRatio : null;

  const problems = [];
  if (olt && maxCascade > limitRatio) {
    problems.push('the deepest splitter cascade is 1:' + maxCascade + ', beyond the ' + olt.model + ' limit of 1:' + limitRatio);
  }
  splitterPorts.forEach(function (row) {
    if (!row.overbooked) return;
    // Name the node by its label and its id: the label is what the planner sees on the canvas, the id
    // is what an API caller greps for, and an unnamed node has only the id.
    const who = row.name === row.node ? '"' + row.node + '"' : '"' + row.name + '" (' + row.node + ')';
    const extra = row.portsUsed - row.ratio;
    problems.push('splitter ' + who + ' has ' + row.portsUsed + ' fibres leaving it on ' + row.ratio +
      ' output ports (' + row.model + ') - ' + extra + (extra === 1 ? ' fibre has' : ' fibres have') + ' no port');
  });
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
    splitterPorts: splitterPorts,
    problems: problems
  };
}

/**
 * A name is a string or it is absent - the one rule every write that carries one keeps.
 *
 * `what` names the field in the refusal; it defaults to the project's own name, and a node passes
 * `node "<id>" name`.
 *
 * `rename` has always stringified (`String(name).trim()`), but `createProject` and `PUT` copied the
 * field through unchanged: `{ name: { a: 1 } }` saved a project whose name is an object, because an
 * object is truthy and JSON-safe and nothing downstream reads the name for anything. The proof is the
 * page a crew takes to site - `GET /print/project/:id` titled itself "[object Object] - plan" - and the
 * project list rendered the same. It is a caller mistake that only becomes visible in print, so it is
 * refused at the write gate, by name, before it lands.
 *
 * Returns the refusal, or null when the field is fine. A missing name is fine: `createProject` defaults
 * it, a design candidate being validated has no name at all, and a node added from the palette is
 * unnamed until somebody names it.
 */
function nameProblem(name, what) {
  if (name === undefined || name === null || typeof name === 'string') return null;
  return (what || 'the project name') + ' must be a string, got ' + jsonTypeName(name);
}

function jsonTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return 'a ' + typeof value;
}

/** Structural validation. Errors refuse a save; warnings are the things a planner should look at. */
function validate(plant, registry) {
  const errors = [];
  const warnings = [];

  if (!plant || typeof plant !== 'object') return { ok: false, errors: ['plant is not an object'], warnings: warnings };
  const nameFault = nameProblem(plant.name);
  if (nameFault) errors.push(nameFault);
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
    // A node's name is printed too: the canvas label, the splice page title, the closure-capacity
    // warning. `apply()` copied it out of the request body raw, so `{ name: {} }` was stored as an
    // object and drawn as "[object Object]". The project's own name has been refused since #129 for
    // exactly this reason; a node name is a string or it is absent (`null` = not named yet).
    const nodeNameFault = nameProblem(node.name, 'node "' + node.id + '" name');
    if (nodeNameFault) errors.push(nodeNameFault);
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
    if (!isSpanCount(span.splices)) {
      errors.push('span "' + span.id + '" has an invalid splices count "' + String(span.splices) + '"');
    }
    if (!isSpanCount(span.closures)) {
      errors.push('span "' + span.id + '" has an invalid closures count "' + String(span.closures) + '"');
    }
    if (!isBundleCount(span.bundles)) {
      errors.push('span "' + span.id + '" has an invalid bundles count "' + String(span.bundles) + '"');
    }
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
 * The tube geometry of the cable a strand is in, as `fiber.addressFor`'s options.
 *
 * TIA-598 numbers a strand by its tube and its position inside it, and how many fibres a tube holds is a
 * property of the cable - a 12-per-tube loose tube and a 24-per-tube ribbon are different trays. Every
 * cable part publishes `fibersPerTube` and `parts.validate` holds it to 1..24, but the addresses here
 * used to be computed with no options at all, i.e. always twelve: a 24-fibre ribbon's strand 25 printed
 * as `T03-F01` when the tray it is in says `T02-F01`. A splice sheet that names the wrong tube is the
 * one error a crew cannot work around, so the address follows the cable. An unknown model keeps the
 * standard default rather than hiding the strand: the sheet still has to list it.
 */
function tubeOptions(span, registry) {
  if (!span || !span.cable || !registry.has('cable', span.cable)) return undefined;
  const cable = registry.get('cable', span.cable);
  if (!isNum(cable.fibersPerTube)) return undefined;
  return { fibersPerTube: cable.fibersPerTube };
}

/**
 * The splice schedule: for every splice point (a closure or a splitter), the strands arriving on each
 * cable and how each one is terminated.
 *
 * This is what a crew works from on paper, and it is derived from the same `span.strands` the strand
 * ledger and the canvas address.
 *
 * A **closure** is a splice: a strand on two cables is joined to its counterpart (`via: 'splice'`,
 * `splicedTo` naming the span on the other side), and a strand on one cable arrives and leaves on no
 * cable, so it is parked (`splicedTo: []`).
 *
 * A **splitter** is not a splice. The feeder fibre is terminated on the splitter's input, and every
 * fibre below it leaves from an output port; nothing is joined to anything. Reporting the feeder
 * strand as `splicedTo` the distribution cable is the one mistake this sheet exists to prevent - a
 * crew that follows it splices the PON port straight to a customer and bypasses the split. So a
 * splitter's rows carry `via: 'splitter-input'` (the cable nearer the head end) or
 * `via: 'splitter-port'` with a 1-based `port`, never a `splicedTo`. Which cable is the input is a
 * fact about the plant - the one nearer the head end by hop count - not about the order the spans
 * happen to be listed in; a splitter tail wins the tie when the plant is not traceable from a root.
 *
 * Indices that are not positive integers are skipped, so one bad hand-edited project cannot make the
 * print page die.
 */
function spliceTable(plant, registry) {
  const nodes = (plant && plant.nodes) || [];
  const spans = (plant && plant.spans) || [];
  const idOf = new Map();
  const spanById = new Map();
  spans.forEach(function (span, i) {
    const id = span.id || '#' + i;
    idOf.set(span, id);
    spanById.set(id, span);
  });

  const depth = nodeDepths(plant);
  const points = [];
  let totalStrands = 0;

  for (const node of nodes) {
    if (node.type !== 'closure' && node.type !== 'splitter') continue;
    const local = spans.filter(function (s) { return s.from === node.id || s.to === node.id; });
    if (!local.length) continue;

    if (node.type === 'splitter') {
      const point = splitterPoint(node, local, idOf, depth, registry);
      if (!point.rows.length) continue;
      totalStrands += point.rows.length;
      points.push(point);
      continue;
    }

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
      carriers.forEach(function (spanId) {
        const others = carriers.filter(function (id) { return id !== spanId; });
        // Each row is the strand *in its own cable*: two cables of different tube sizes splice the same
        // strand index under two different addresses, which is exactly what the crew reads off the trays.
        const address = fiber.addressFor(index, tubeOptions(spanById.get(spanId), registry));
        rows.push({
          span: spanId,
          strand: index,
          address: address.label,
          colour: address.fiberColor.name,
          hex: address.fiberColor.hex,
          via: others.length ? 'splice' : 'parked',
          port: null,
          splicedTo: others
        });
      });
    });
    totalStrands += rows.length;
    points.push({
      node: node.id,
      name: node.name || node.id,
      type: node.type,
      model: node.model || null,
      ratio: null,
      termination: null,
      spans: local.map(function (s) { return idOf.get(s); }),
      rows: rows
    });
  }

  return { points: points, totalStrands: totalStrands };
}

/**
 * Hop count from the head end, for every node it can reach.
 *
 * A splitter's input is the cable on the head-end side. `nodeDepths` answers that with the plant's
 * own topology; an empty map (no single root yet) leaves the caller to fall back on a splitter tail.
 */
function nodeDepths(plant) {
  const depth = new Map();
  const roots = rootNodes(plant);
  if (roots.length !== 1) return depth;
  const adj = adjacency(plant);
  depth.set(roots[0].id, 0);
  const queue = [roots[0].id];
  while (queue.length) {
    const id = queue.shift();
    for (const edge of adj.get(id) || []) {
      if (depth.has(edge.to)) continue;
      depth.set(edge.to, depth.get(id) + 1);
      queue.push(edge.to);
    }
  }
  return depth;
}

/** Order the cables at a splitter: the input first, then the outputs, deterministically. */
function orderSplitterCables(node, local, idOf, depth) {
  function farDepth(span) {
    const other = span.from === node.id ? span.to : span.from;
    return depth.has(other) ? depth.get(other) : null;
  }
  return local.slice().sort(function (a, b) {
    const da = farDepth(a);
    const db = farDepth(b);
    // A cable with no depth is not on the traced tree: it sorts after any cable that is.
    if ((da === null) !== (db === null)) return da === null ? 1 : -1;
    // A splitter tail into the splitter is the input by definition (it is 1 m of fibre into the box).
    const ta = a.purpose === 'splitter-tail' ? 0 : 1;
    const tb = b.purpose === 'splitter-tail' ? 0 : 1;
    if (ta !== tb) return ta - tb;
    if (da !== null && da !== db) return da - db;
    const ia = String(idOf.get(a));
    const ib = String(idOf.get(b));
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function splitterPoint(node, local, idOf, depth, registry) {
  const part = node.model && registry.has('splitter', node.model) ? registry.get('splitter', node.model) : null;
  const ordered = orderSplitterCables(node, local, idOf, depth);
  const rows = [];
  let port = 0;

  for (const span of ordered) {
    const isInput = span === ordered[0];
    const seen = new Set();
    for (const raw of Array.isArray(span.strands) ? span.strands : []) {
      const index = Number(raw);
      if (!Number.isInteger(index) || index < 1) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      const address = fiber.addressFor(index, tubeOptions(span, registry));
      rows.push({
        span: idOf.get(span),
        strand: index,
        address: address.label,
        colour: address.fiberColor.name,
        hex: address.fiberColor.hex,
        via: isInput ? 'splitter-input' : 'splitter-port',
        port: isInput ? null : ++port,
        splicedTo: []
      });
    }
  }

  return {
    node: node.id,
    name: node.name || node.id,
    type: node.type,
    model: node.model || null,
    ratio: part ? part.ratio : null,
    termination: part ? (part.termination || 'spliced') : null,
    spans: ordered.map(function (s) { return idOf.get(s); }),
    rows: rows
  };
}

module.exports = {
  NODE_TYPES: NODE_TYPES,
  trace: trace,
  designForOnt: designForOnt,
  allOntBudgets: allOntBudgets,
  budgetRow: budgetRow,
  strandLedger: strandLedger,
  spliceTable: spliceTable,
  capacity: capacity,
  validate: validate,
  nameProblem: nameProblem,
  isSpanCount: isSpanCount,
  isBundleCount: isBundleCount,
  stats: stats
};
