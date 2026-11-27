'use strict';
/**
 * A project is the design: nodes, spans, and enough history to take back the last 50 things.
 *
 * Deliberately pure data and pure functions. The server persists the JSON; this module never
 * touches the disk, never generates a timestamp it cannot be told, and never mutates the project it
 * is handed - `apply` returns a new object. That is what makes undo a copy rather than a `git reset`
 * and what lets two callers (the HTTP API and a test) drive the same design without stepping on
 * each other.
 */

const network = require('./network');

const MAX_HISTORY = 50;
const NODE_TYPES = network.NODE_TYPES;

function nowIso(clock) {
  return (clock ? new Date(clock) : new Date()).toISOString();
}

function cloneState(project) {
  return {
    name: project.name,
    nodes: JSON.parse(JSON.stringify(project.nodes || [])),
    spans: JSON.parse(JSON.stringify(project.spans || []))
  };
}

function createProject(name, opts) {
  const o = opts || {};
  const created = nowIso(o.now);
  return {
    id: o.id || null,
    name: name || 'Untitled project',
    createdAt: created,
    updatedAt: created,
    nodes: [],
    spans: [],
    history: [],
    version: 1
  };
}

function nextId(list, prefix) {
  let max = 0;
  for (const item of list || []) {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(String(item.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + (max + 1);
}

function snapshot(project, op, clock) {
  const history = (project.history || []).concat([{
    at: nowIso(clock),
    op: op,
    state: cloneState(project)
  }]);
  return history.slice(Math.max(0, history.length - MAX_HISTORY));
}

/**
 * Apply one operation. Returns `{ project, error }` and never throws for bad input: an API that
 * rejects a bad edit with a reason is more useful than a 500, and the caller keeps the old project.
 *
 * Ops:
 *   { op: 'add-node',  node: { type, model?, name?, lat?, lon? } }
 *   { op: 'add-span',  span: { from, to, cable, lengthM, strands?, splices?, closures?,
 *                                 bundles?, dropReserveM?, purpose?, route? } }
 *   { op: 'update-node', id, patch: { name?, model?, lat?, lon? } }
 *   { op: 'move-node', id, lat, lon }
 *   { op: 'remove-node', id }
 *   { op: 'remove-span', id }
 *   { op: 'rename', name }
 */
function apply(project, operation, opts) {
  const o = opts || {};
  if (!project) return { error: 'no project' };
  if (!operation || !operation.op) return { error: 'operation.op is required' };

  const next = {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    nodes: JSON.parse(JSON.stringify(project.nodes || [])),
    spans: JSON.parse(JSON.stringify(project.spans || [])),
    history: (project.history || []).slice(),
    version: project.version || 1
  };

  const fail = function (message) { return { error: message }; };

  switch (operation.op) {
    case 'add-node': {
      const input = operation.node || {};
      if (NODE_TYPES.indexOf(input.type) === -1) return fail('node.type must be one of ' + NODE_TYPES.join(', '));
      const rootTypes = ['olt', 'headend'];
      if (rootTypes.indexOf(input.type) !== -1 && next.nodes.some(function (n) { return rootTypes.indexOf(n.type) !== -1; })) {
        return fail(input.type === 'olt'
          ? 'this project already has an OLT node'
          : 'this project already has a head-end node');
      }
      const node = {
        id: input.id || nextId(next.nodes, 'n'),
        type: input.type,
        model: input.model || null,
        name: input.name || null,
        lat: input.lat === undefined ? null : input.lat,
        lon: input.lon === undefined ? null : input.lon
      };
      if (next.nodes.some(function (n) { return n.id === node.id; })) return fail('node id "' + node.id + '" already exists');
      next.history = snapshot(project, operation.op + ' ' + node.id, o.now);
      next.nodes.push(node);
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'add-span': {
      const input = operation.span || {};
      if (!input.from || !input.to) return fail('span.from and span.to are required');
      if (!next.nodes.some(function (n) { return n.id === input.from; })) return fail('unknown node "' + input.from + '"');
      if (!next.nodes.some(function (n) { return n.id === input.to; })) return fail('unknown node "' + input.to + '"');
      if (input.from === input.to) return fail('a span cannot start and end at the same node');
      if (!input.cable) return fail('span.cable is required');
      if (typeof input.lengthM !== 'number' || !isFinite(input.lengthM) || input.lengthM <= 0) {
        return fail('span.lengthM must be a positive number of metres');
      }
      // A count, not whatever the caller's form sent. `input.splices || 0` used to copy text straight
      // through, and cableToBuy refuses text - so the edit was saved with a 200 and every later /bom
      // call for the project was a 500, blaming the server for a typo made at save time.
      const splices = input.splices === undefined ? 0 : input.splices;
      const closures = input.closures === undefined ? 0 : input.closures;
      if (!network.isSpanCount(splices)) {
        return fail('span.splices must be a non-negative whole number or a list of splices, got "' +
          String(input.splices) + '"');
      }
      if (!network.isSpanCount(closures)) {
        return fail('span.closures must be a non-negative whole number or a list of closures, got "' +
          String(input.closures) + '"');
      }
      // The rest of the span model, carried rather than dropped. `bundles` is the one that costs
      // money: the BOM multiplies the measured route by it, so a span that really runs two cables
      // was billed as one and the order came up half the cable - answered 200, no field in the
      // saved span, nothing said. `dropReserveM` is a term of the same BOM, and `purpose` is what
      // the splice schedule reads to know a 1 m tail is a splitter's input. `PUT` keeps all three
      // from the same body, so this op losing them made two writers disagree about one plant. A
      // value the plant cannot hold is refused by name - the validator's own bundle rule - instead
      // of being dropped, because a dropped field is a 200 that hides a short order.
      if (input.bundles !== undefined && !network.isBundleCount(input.bundles)) {
        return fail('span.bundles must be a positive whole number of cables, got "' +
          String(input.bundles) + '" - a span runs one cable or more');
      }
      if (input.dropReserveM !== undefined &&
          (typeof input.dropReserveM !== 'number' || !isFinite(input.dropReserveM) || input.dropReserveM < 0)) {
        return fail('span.dropReserveM must be a non-negative number of metres, got "' +
          String(input.dropReserveM) + '"');
      }
      if (input.purpose !== undefined &&
          (typeof input.purpose !== 'string' || !input.purpose.trim())) {
        return fail('span.purpose must be a non-empty word, got "' + String(input.purpose) + '"');
      }
      const span = {
        id: input.id || nextId(next.spans, 's'),
        from: input.from,
        to: input.to,
        cable: input.cable,
        lengthM: input.lengthM,
        strands: Array.isArray(input.strands) ? input.strands.slice() : [],
        splices: splices,
        closures: closures,
        route: Array.isArray(input.route) ? input.route : null
      };
      if (input.bundles !== undefined) span.bundles = input.bundles;
      if (input.dropReserveM !== undefined) span.dropReserveM = input.dropReserveM;
      if (input.purpose !== undefined) span.purpose = input.purpose.trim();
      if (next.spans.some(function (s) { return s.id === span.id; })) return fail('span id "' + span.id + '" already exists');
      next.history = snapshot(project, operation.op + ' ' + span.id, o.now);
      next.spans.push(span);
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'update-node': {
      const node = next.nodes.find(function (n) { return n.id === operation.id; });
      if (!node) return fail('unknown node "' + operation.id + '"');
      const patch = operation.patch || {};
      for (const key of ['name', 'model', 'lat', 'lon', 'type']) {
        if (patch[key] !== undefined) node[key] = patch[key];
      }
      next.history = snapshot(project, operation.op + ' ' + node.id, o.now);
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'move-node': {
      const node = next.nodes.find(function (n) { return n.id === operation.id; });
      if (!node) return fail('unknown node "' + operation.id + '"');
      if (typeof operation.lat !== 'number' || typeof operation.lon !== 'number') return fail('move-node needs numeric lat and lon');
      next.history = snapshot(project, operation.op + ' ' + node.id, o.now);
      node.lat = operation.lat;
      node.lon = operation.lon;
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'remove-node': {
      const exists = next.nodes.some(function (n) { return n.id === operation.id; });
      if (!exists) return fail('unknown node "' + operation.id + '"');
      next.history = snapshot(project, operation.op + ' ' + operation.id, o.now);
      next.nodes = next.nodes.filter(function (n) { return n.id !== operation.id; });
      next.spans = next.spans.filter(function (s) { return s.from !== operation.id && s.to !== operation.id; });
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'remove-span': {
      const exists = next.spans.some(function (s) { return s.id === operation.id; });
      if (!exists) return fail('unknown span "' + operation.id + '"');
      next.history = snapshot(project, operation.op + ' ' + operation.id, o.now);
      next.spans = next.spans.filter(function (s) { return s.id !== operation.id; });
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'rename': {
      // A name is a string or it is absent - the rule `createProject` and `PUT` keep (#129) - and this
      // op was the way around it: `String(name).trim()` turned `{ name: {} }` into "[object Object]"
      // and the printed plan titled itself with it. The trim stays for a real name.
      if (operation.name === undefined || operation.name === null) return fail('rename needs a name');
      const nameFault = network.nameProblem(operation.name);
      if (nameFault) return fail(nameFault);
      if (!operation.name.trim()) return fail('rename needs a name');
      next.history = snapshot(project, operation.op, o.now);
      next.name = operation.name.trim();
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    default:
      return fail('unknown op "' + operation.op + '"');
  }
}

/**
 * Replace the whole plant, as one edit with one undo step.
 *
 * Auto-design produces nodes and spans wholesale; applying them through `add-node` fifty times would
 * fill the undo history with the machinery and leave the user pressing undo for a minute to get back
 * to the design they had. One operation, one step.
 */
function replacePlant(project, plant, opts) {
  const o = opts || {};
  if (!project) return { error: 'no project' };
  if (!plant || !Array.isArray(plant.nodes) || !Array.isArray(plant.spans)) {
    return { error: 'replacePlant needs a plant with nodes and spans' };
  }
  const next = {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: nowIso(o.now),
    nodes: JSON.parse(JSON.stringify(plant.nodes)),
    spans: JSON.parse(JSON.stringify(plant.spans)),
    history: snapshot(project, 'replace-plant', o.now),
    version: project.version || 1
  };
  return { project: next };
}

/** Take back the last edit. Returns `{ project, undone }`; the oldest state falls off at 50. */
function undo(project) {
  const history = (project.history || []).slice();
  if (!history.length) return { project: project, undone: null };
  const last = history.pop();
  return {
    project: {
      id: project.id,
      name: last.state.name,
      createdAt: project.createdAt,
      updatedAt: nowIso(),
      nodes: last.state.nodes,
      spans: last.state.spans,
      history: history,
      version: project.version || 1
    },
    undone: last
  };
}

function check(project, registry) {
  const structural = network.validate(project, registry);
  const errors = structural.errors.slice();
  const warnings = structural.warnings.slice();
  if (!project.id) warnings.push('project has no id yet');
  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

function summary(project, registry) {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    nodes: (project.nodes || []).length,
    spans: (project.spans || []).length,
    onts: (project.nodes || []).filter(function (n) { return n.type === 'ont'; }).length,
    routeM: Math.round((project.spans || []).reduce(function (n, s) { return n + (s.lengthM || 0); }, 0) * 10) / 10,
    capacity: registry ? network.capacity(project, registry) : null
  };
}

module.exports = {
  MAX_HISTORY: MAX_HISTORY,
  createProject: createProject,
  apply: apply,
  replacePlant: replacePlant,
  undo: undo,
  check: check,
  summary: summary,
  nextId: nextId
};
