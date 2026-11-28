'use strict';
// A span's `route` is the drawn street geometry, and two surfaces project every point of it: the
// canvas (`web/scene.js`) and the printed plan (`server/index.js`, `planSvg`).
//
// The bug this exists for (gh#149): neither the save gate nor `/ops` looked at those points, so a
// route holding `null` passed `PUT` with a 200 and `GET /print/project/:id` then answered 500
// ("Cannot read properties of null (reading 'lon')") - the page a crew signs off, down, on a plant
// the gate had just accepted. `/ops` was worse in a quieter way: `route: "51.5,-0.1"` was answered
// 200 with the field silently dropped.
//
// Nothing in the plant reads a route for money or loss, so the rule is the readers': a route is a
// list of { lat, lon } points, present-but-wrong is refused by span and point index, absent stays
// absent (a span drawn as a straight line), and a project stored before the gate still prints.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const engine = require('../engine');
const { createServer } = require('../server/index');

const registry = engine.createRegistry();

// ---------------------------------------------------------------- the gate

function plantWithRoute(route) {
  return {
    name: 'Route gate',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-b-plus-16', name: 'OLT', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'House', lat: 51.501, lon: -0.1 }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 120,
        splices: 0, closures: 0, strands: [1], route: route }
    ]
  };
}

function routeErrors(route) {
  return engine.network.validate(plantWithRoute(route), registry).errors;
}

test('a routed span with placeable points validates clean', function () {
  const route = [{ lat: 51.5, lon: -0.1 }, { lat: 51.5005, lon: -0.1002 }, { lat: 51.501, lon: -0.1 }];
  // 3 points x 2 coordinates, all inside +/-90 / +/-180: nothing for the gate to say.
  assert.deepStrictEqual(routeErrors(route), []);
});

test('a route holding null is refused by span and point index', function () {
  const errors = routeErrors([null, { lat: 51.5, lon: -0.1 }, { lat: 51.501, lon: -0.1 }]);
  assert.strictEqual(errors.length, 1, 'one sentence for the one bad point: ' + errors.join(' | '));
  assert.ok(errors[0].indexOf('span "s1"') !== -1, 'the refusal names the span: ' + errors[0]);
  assert.ok(errors[0].indexOf('route point 0') !== -1, 'the refusal names the point: ' + errors[0]);
  assert.ok(errors[0].indexOf('{ lat, lon }') !== -1, 'the refusal says what a point is: ' + errors[0]);
});

test('a route point outside the coordinate range is refused, not handed to a projector', function () {
  // lat 91 is a number a projector happily plots 10,120 km away; `geo.isCoordinate` is the range rule.
  const errors = routeErrors([{ lat: 51.5, lon: -0.1 }, { lat: 91, lon: -0.1 }, { lat: 51.501, lon: -0.1 }]);
  assert.strictEqual(errors.length, 1, 'one sentence for the one bad point: ' + errors.join(' | '));
  assert.ok(errors[0].indexOf('route point 1') !== -1, 'the refusal names the point: ' + errors[0]);
});

test('a route that is not a list is refused rather than read as no route', function () {
  // "51.5,-0.1" is not a silent absence: it is the caller's drawing in a shape no reader takes.
  const errors = routeErrors('51.5,-0.1;51.501,-0.1');
  assert.strictEqual(errors.length, 1, 'one sentence for the field: ' + errors.join(' | '));
  assert.ok(errors[0].indexOf('span "s1"') !== -1, 'the refusal names the span: ' + errors[0]);
  assert.ok(errors[0].indexOf('51.5,-0.1;51.501,-0.1') !== -1, 'the refusal quotes what arrived: ' + errors[0]);
});

test('an absent route, a null route and an empty route stay legitimate', function () {
  // Absent/null is "draw the straight line between the nodes"; `[]` is a route with nothing drawn.
  // None of the three is a value the readers cannot place.
  assert.deepStrictEqual(routeErrors(undefined), []);
  assert.deepStrictEqual(routeErrors(null), []);
  assert.deepStrictEqual(routeErrors([]), []);
});

// ---------------------------------------------------------------- the two writers

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-route-'));
const server = createServer({ dataRoot: dataRoot });
let base = null;

function request(method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(base + pathname, {
      method: method,
      headers: Object.assign({}, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { /* html */ }
        resolve({ status: res.statusCode, body: json, text: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedNodes(id) {
  const steps = [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-b-plus-16', name: 'OLT', lat: 51.5, lon: -0.1 } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'House', lat: 51.501, lon: -0.1 } }
  ];
  for (const step of steps) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op failed: ' + answer.text);
  }
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const created = await request('POST', '/api/projects', { name: 'Route gate' });
  const putId = created.body.id;
  const put = await request('PUT', '/api/projects/' + putId, plantWithRoute(
    [null, { lat: 51.5, lon: -0.1 }, { lat: 51.501, lon: -0.1 }]));

  test('PUT refuses a route the readers cannot project, by span and point', function () {
    assert.strictEqual(put.status, 400, 'expected a 400, got ' + put.status + ': ' + put.text.slice(0, 200));
    assert.ok(put.body && Array.isArray(put.body.errors),
      'the refusal carries the errors array: ' + put.text.slice(0, 200));
    assert.ok(put.body.errors.join(' ').indexOf('route point 0') !== -1,
      'the refusal names the point: ' + put.body.errors.join(' | '));
  });

  // A second project: the PUT above replaced this one's plant, and a plant has exactly one OLT.
  const opsProject = await request('POST', '/api/projects', { name: 'Ops route gate' });
  const opsId = opsProject.body.id;
  await seedNodes(opsId);
  const span = await request('POST', '/api/projects/' + opsId + '/ops', {
    op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 120,
      route: '51.5,-0.1;51.501,-0.1' }
  });

  test('/ops names a non-list route instead of answering 200 with the field dropped', function () {
    assert.strictEqual(span.status, 400, 'expected a 400, got ' + span.status + ': ' + span.text.slice(0, 200));
    assert.ok(span.text.indexOf('route') !== -1, 'the refusal names the field: ' + span.text.slice(0, 300));
  });

  // A project stored before the gate existed: written straight to disk, never through `PUT`.
  const legacyId = 'route-legacy-1';
  fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'projects', legacyId + '.json'), JSON.stringify({
    id: legacyId,
    name: 'Legacy routed plan',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-b-plus-16', name: 'OLT', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'House', lat: 51.501, lon: -0.1 }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 120, splices: 0, closures: 0,
        strands: [1], route: [null, { lat: 51.5, lon: -0.1 }, { lat: 51.501, lon: -0.1 }] }
    ],
    history: [],
    version: 1
  }, null, 2) + '\n');

  const printed = await request('GET', '/print/project/' + legacyId);

  test('a stored project that predates the gate still prints its plan', function () {
    assert.strictEqual(printed.status, 200,
      'the printed plan must survive a route it cannot place, got ' + printed.status + ': ' + printed.text.slice(0, 200));
    assert.ok(printed.text.indexOf('Legacy routed plan') !== -1, 'the page prints the plan title');
    assert.ok(printed.text.indexOf('NaN') === -1, 'the page must not print a NaN-coordinate drawing');
    assert.ok(printed.text.indexOf('120 m') !== -1, 'the span is still drawn and measured: it is the cable line');
  });

  // The fallback must not swallow a route it can draw: a valid three-point route still prints as a
  // polyline of its three projected points, so gh#149's guard did not turn every drawn span into a
  // straight line between its nodes.
  const drawnId = 'route-drawn-2';
  fs.writeFileSync(path.join(dataRoot, 'projects', drawnId + '.json'), JSON.stringify({
    id: drawnId,
    name: 'Drawn route plan',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-b-plus-16', name: 'OLT', lat: 51.5, lon: -0.1 },
      { id: 'n2', type: 'ont', model: 'gpon-ont-b-plus-4ge', name: 'House', lat: 51.501, lon: -0.1 }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 120, splices: 0, closures: 0,
        strands: [1], route: [{ lat: 51.5, lon: -0.1 }, { lat: 51.5005, lon: -0.1002 }, { lat: 51.501, lon: -0.1 }] }
    ],
    history: [],
    version: 1
  }, null, 2) + '\n');
  const drawn = await request('GET', '/print/project/' + drawnId);

  test('a route the readers can place still prints as a polyline', function () {
    assert.strictEqual(drawn.status, 200, 'the valid routed plan prints: ' + drawn.text.slice(0, 200));
    // 51.5,-0.1 -> 51.5005,-0.1002 -> 51.501,-0.1 is three sited vertices, so the span is drawn
    // along its geometry: one polyline, three projected points, no NaN.
    const match = /<polyline points="([^"]+)"/.exec(drawn.text);
    assert.ok(match, 'the routed span prints as a polyline');
    assert.strictEqual(match[1].split(' ').length, 3, 'three projected points: ' + match[1]);
    assert.ok(match[1].indexOf('NaN') === -1, 'no NaN coordinate: ' + match[1]);
  });

  await new Promise(function (resolve) { server.close(resolve); });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  done();
}

main().catch(function (err) {
  console.error('FAIL suite crashed: ' + (err && err.stack ? err.stack : err));
  require('./harness').state.failed++;
  try { server.close(); } catch (e) { /* already closed */ }
  done();
  process.exitCode = 1;
});
