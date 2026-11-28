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

// A project's `nodes`/`spans` come from a JSON file and from `PUT` bodies, either of which can hold
// `null` where an object belongs. `network.validate` names that entry; the summary below is built
// for the same project - `GET /api/projects/:id` asks for both - so it skips what it cannot read
// instead of dereferencing it (that threw a 500 out of the endpoint the user opens to fix the file).
const isEntry = network.isEntry;

const MAX_HISTORY = 50;
const NODE_TYPES = network.NODE_TYPES;

function nowIso(clock) {
  return (clock ? new Date(clock) : new Date()).toISOString();
}

/**
 * A placement is a pair, and an edit is where half a pair used to be stored.
 *
 * `network.validate` checks `lat` and `lon` one at a time, and `null` on both means "not on a map
 * yet" - a legitimate state for a node added from the palette. One coordinate is neither state: the
 * canvas draws an unplaced node at the centre of the map (`web/scene.js`, `placed: false`), so
 * `{ lat: 51.5, lng: -0.1 }` was stored as a node at 51.5 with no longitude, answered 200, passed
 * `validate` because a null longitude looks like "not placed yet", and was drawn in the middle of an
 * arbitrary view rather than on its street. `lng` is the key every map library but GeoJSON uses, and
 * `engine/demand.js` already reads it on an imported demand list - so the edit names it instead of
 * dropping it. `PUT` and a hand-edited file reach the same half through `network.validate`; this is
 * the writer refusing it while the value is still visible.
 */
const LAT_LIMIT = 90;
const LON_LIMIT = 180;

/** A value as the caller sent it: JSON where JSON can say it, `String` otherwise (`JSON.stringify(NaN)` is `null`). */
function showCoordinate(value) {
  if (typeof value === 'number' && !isFinite(value)) return String(value);
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/** One coordinate the plant can hold, or a sentence naming the one it cannot. */
function coordinateProblem(label, value, limit) {
  if (typeof value !== 'number' || !isFinite(value) || Math.abs(value) > limit) {
    return label + ' must be a number between -' + limit + ' and ' + limit + ', got ' + showCoordinate(value);
  }
  return null;
}

/** `lat` and `lon` together, or neither - never one, and never a `lng` that quietly places nothing. */
function placementProblem(input, what) {
  if (input.lng !== undefined) {
    return what + '.lng is not a field this model reads - did you mean "lon"? A node is placed at lat and lon, or at neither: a longitude under another name was dropped, so the node was drawn at the centre of the canvas, not where it is';
  }
  const hasLat = input.lat !== undefined && input.lat !== null;
  const hasLon = input.lon !== undefined && input.lon !== null;
  if (hasLat !== hasLon) {
    return what + ' is placed with ' + (hasLat ? 'a latitude and no longitude' : 'a longitude and no latitude') +
      ' - lat and lon are one placement (null on both means "not on a map yet"), so a node is placed at both or neither, and half a pair is drawn at the centre of the canvas';
  }
  if (!hasLat) return null;
  return coordinateProblem(what + '.lat', input.lat, LAT_LIMIT) ||
    coordinateProblem(what + '.lon', input.lon, LON_LIMIT);
}

/**
 * The `id` an operation acts on, or the sentence that names the field it never carried.
 *
 * Four ops target an entry that already exists - `update-node`, `move-node`, `remove-node`,
 * `remove-span` - and each looked up `operation.id` directly. With no `id` that is `undefined`, so
 * the lookup missed and the refusal read `unknown node "undefined"`: a sentence that names a node
 * the caller never wrote, sends them through the plant looking for it, and never says the field is
 * the thing missing. `id: ""` (an untouched `<select>`, a row nobody picked) answered
 * `unknown node ""` for the same reason. `add-span` refuses a missing `from` by naming the field
 * and `rename` says `rename needs a name`; this is the same sentence for the same mistake.
 *
 * A real id that names nothing is still the caller's target being gone, and that message keeps
 * quoting the id (`unknown node "n9"`) - the two cases are different mistakes.
 */
function opIdProblem(operation, op, action) {
  const id = operation.id;
  if (id !== undefined && id !== null && id !== '') return null;
  return 'operation.id is required - ' + op + ' takes the id of the ' + action;
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
      // Before the root check and the id: a node with half a placement is not a node, however well
      // it lists its type. See `placementProblem`.
      const coordFault = placementProblem(input, 'node');
      if (coordFault) return fail(coordFault);
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
        // A strand list is a list, or absent. The array is copied; anything else goes through
        // untouched so the write gate names it - coercing it to `[]` here was a 200 that dropped
        // the caller's strands in silence, and `PUT` stored the same value raw. One rule, one
        // sentence, whichever writer met it first.
        strands: input.strands === undefined
          ? []
          : Array.isArray(input.strands) ? input.strands.slice() : input.strands,
        splices: splices,
        closures: closures,
        // The drawn route is geometry, and the gate (network.validate) is what reads it - the
        // same rule as strands above. Coercing a non-list to null here was a 200 that dropped the
        // caller's field; a list is copied so the stored plant does not alias the request body,
        // and anything else goes through untouched so the write names it.
        route: input.route === undefined ? null
          : Array.isArray(input.route) ? input.route.slice() : input.route
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
      const idFault = opIdProblem(operation, 'update-node', 'node to update');
      if (idFault) return fail(idFault);
      const node = next.nodes.find(function (n) { return n.id === operation.id; });
      if (!node) return fail('unknown node "' + operation.id + '"');
      const patch = operation.patch || {};
      // `type` is not part of this op - `patch` takes name, model, lat and lon - yet the copy below
      // used to store it, and a node's type is not a cosmetic label: the root's type picks the
      // technology (olt budgets a PON, headend an active link) and `trace`/`computeOdn` charge a
      // splitter's loss only on a node of type splitter. Retyping the splitter of a healthy 1:8
      // estate to a closure kept its splitter model as a warning, dropped the 10.5 dB from the ODN
      // (11.53 -> 1.03) and answered 200 on a plant that now reads "fail - too loud, fit a 14 dB
      // pad"; retyping the only ONT deleted the customer from /budget and the BOM the same way.
      // A different kind of node is a remove and an add. The same value echoed back is not a change,
      // so a writer that sends the whole node keeps working.
      if (patch.type !== undefined && patch.type !== node.type) {
        return fail('node "' + node.id + '" is a ' + node.type + ' - update-node cannot change the type of a node to "' +
          String(patch.type) + '"; patch takes name, model, lat and lon, and a node of another kind is a remove and an add');
      }
      // The pair as the patch would leave it, not just the keys it names: setting one axis of an
      // unplaced node is the same half an `add-node` refuses, and `lng` here is a patch that moves
      // nothing. `{ lat: null, lon: null }` is still how a node is taken off the map. A patch that
      // does not touch a coordinate is not asked about the pair, so a legacy half can still be
      // renamed - `validate` is what names it, and `{ lon }` is how it is fixed.
      if (patch.lat !== undefined || patch.lon !== undefined || patch.lng !== undefined) {
        const placedFault = placementProblem({
          lat: patch.lat !== undefined ? patch.lat : node.lat,
          lon: patch.lon !== undefined ? patch.lon : node.lon,
          lng: patch.lng
        }, 'node "' + node.id + '"');
        if (placedFault) return fail(placedFault);
      }
      for (const key of ['name', 'model', 'lat', 'lon']) {
        if (patch[key] !== undefined) node[key] = patch[key];
      }
      next.history = snapshot(project, operation.op + ' ' + node.id, o.now);
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'move-node': {
      const idFault = opIdProblem(operation, 'move-node', 'node to move');
      if (idFault) return fail(idFault);
      const node = next.nodes.find(function (n) { return n.id === operation.id; });
      if (!node) return fail('unknown node "' + operation.id + '"');
      // A move is a placement too: `lat: 999` was stored and read back as an invalid latitude only
      // on the next `GET`, so the edit that made it answered 200.
      const movedFault = coordinateProblem('move-node.lat', operation.lat, LAT_LIMIT) ||
        coordinateProblem('move-node.lon', operation.lon, LON_LIMIT);
      if (movedFault) return fail(movedFault);
      next.history = snapshot(project, operation.op + ' ' + node.id, o.now);
      node.lat = operation.lat;
      node.lon = operation.lon;
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'remove-node': {
      const idFault = opIdProblem(operation, 'remove-node', 'node to remove');
      if (idFault) return fail(idFault);
      const exists = next.nodes.some(function (n) { return n.id === operation.id; });
      if (!exists) return fail('unknown node "' + operation.id + '"');
      next.history = snapshot(project, operation.op + ' ' + operation.id, o.now);
      next.nodes = next.nodes.filter(function (n) { return n.id !== operation.id; });
      next.spans = next.spans.filter(function (s) { return s.from !== operation.id && s.to !== operation.id; });
      next.updatedAt = nowIso(o.now);
      return { project: next };
    }

    case 'remove-span': {
      const idFault = opIdProblem(operation, 'remove-span', 'span to remove');
      if (idFault) return fail(idFault);
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
    onts: (project.nodes || []).filter(function (n) { return isEntry(n) && n.type === 'ont'; }).length,
    // The plant's own sum, not a second rule: `n + "100"` concatenates, so this line read two
    // hand-edited 100 m spans as 100100 m while `stats.routeM` beside it read 0 (both are under
    // `GET /api/projects/:id`'s `derived`). See `network.routeLengthM` - one definition.
    routeM: Math.round(network.routeLengthM(project) * 10) / 10,
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
