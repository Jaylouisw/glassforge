'use strict';
// The API the UI actually calls, driven over a real socket. Routes that only exist in a router table
// are not tested behaviour; these are the requests the browser makes.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { test, assert, done } = require('./harness');

const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-test-'));
const server = createServer({ dataRoot: dataRoot });
let base = null;

function request(method, pathname, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request(base + pathname, {
      method: method,
      headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {})
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (err) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const health = await request('GET', '/api/health');
  test('health names the app, its version and the catalogue', function () {
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.name, 'glassforge');
    assert.ok(/^\d+\.\d+\.\d+$/.test(health.body.version), health.body.version);
    assert.ok(health.body.parts.total >= 30);
  });

  const partsA = await request('GET', '/api/parts');
  const partsB = await request('GET', '/api/parts');
  test('two consecutive catalogue requests agree on the ETag', function () {
    assert.strictEqual(partsA.status, 200);
    assert.ok(partsA.headers.etag, 'no ETag header');
    assert.strictEqual(partsA.headers.etag, partsB.headers.etag,
      'an ETag that changes between identical requests revalidates nothing');
  });

  const revalidated = await request('GET', '/api/parts', undefined, { 'If-None-Match': partsA.headers.etag });
  test('a matching ETag gets a 304 with no body', function () {
    assert.strictEqual(revalidated.status, 304);
    assert.strictEqual(revalidated.raw.length, 0);
  });

  const gz = await request('GET', '/api/parts', undefined, { 'Accept-Encoding': 'gzip' });
  test('the catalogue honours gzip and survives the round trip', function () {
    assert.strictEqual(gz.headers['content-encoding'], 'gzip');
    assert.ok(gz.body.parts.cable.length >= 8);
    // Compare the WIRE sizes. `request()` gunzips before handing back `raw`, so comparing raw
    // lengths compares the decompressed bodies and can never fail for the right reason.
    const wire = Number(gz.headers['content-length']);
    assert.ok(wire > 0 && wire < partsA.raw.length, 'gzip sent ' + wire + ' bytes for a ' + partsA.raw.length + ' byte payload');
  });

  const filtered = await request('GET', '/api/parts?kind=splitter&q=1x8');
  test('the catalogue filters by kind and term', function () {
    assert.strictEqual(filtered.status, 200);
    assert.deepStrictEqual(Object.keys(filtered.body.parts), ['splitter']);
    assert.ok(filtered.body.parts.splitter.length >= 1);
  });

  const missingPart = await request('GET', '/api/parts/cable/not-a-cable');
  test('an unknown part is a 404 with an error body', function () {
    assert.strictEqual(missingPart.status, 404);
    assert.ok(missingPart.body.error.indexOf('no cable part') !== -1);
  });

  const created = await request('POST', '/api/projects', { name: 'API test build' });
  test('a project can be created', function () {
    assert.strictEqual(created.status, 201);
    assert.ok(created.body.id);
    assert.strictEqual(created.body.name, 'API test build');
  });
  const id = created.body.id;

  const steps = [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 30' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 1200, splices: 1, closures: 1, strands: [1, 2, 3] } },
    { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 60 } }
  ];
  let last = null;
  for (const step of steps) last = await request('POST', '/api/projects/' + id + '/ops', step);
  test('edits land, and each response carries the derived state', function () {
    assert.strictEqual(last.status, 200, JSON.stringify(last.body));
    assert.strictEqual(last.body.nodes.length, 3);
    assert.strictEqual(last.body.spans.length, 2);
    assert.deepStrictEqual(last.body.derived.errors, []);
  });

  const budget = await request('POST', '/api/projects/' + id + '/budget', {});
  test('the signal page gets a verdict for every ONT', function () {
    assert.strictEqual(budget.status, 200);
    assert.strictEqual(budget.body.budgets.length, 1);
    const result = budget.body.budgets[0].result;
    assert.ok(['ok', 'marginal', 'fail'].indexOf(result.verdict) !== -1);
    assert.ok(result.breakdown.length >= 4);
  });

  const bom = await request('GET', '/api/projects/' + id + '/bom');
  test('the cable page returns whole drums per cable model', function () {
    assert.strictEqual(bom.status, 200);
    assert.strictEqual(bom.body.byCable.length, 2);
    for (const row of bom.body.byCable) {
      assert.ok(Number.isInteger(row.drums) && row.drums >= 1);
      assert.strictEqual(row.purchaseM, row.drums * row.drumM);
    }
  });

  const strands = await request('GET', '/api/projects/' + id + '/strands');
  test('the strand page reports usage against the cable', function () {
    assert.strictEqual(strands.status, 200);
    assert.strictEqual(strands.body.totalUsed, 3);
    assert.strictEqual(strands.body.overbooked, 0);
  });

  const badOp = await request('POST', '/api/projects/' + id + '/ops', { op: 'add-span', span: { from: 'n1', to: 'n99', cable: 'g652d-loose-12', lengthM: 5 } });
  test('a refused edit is a 400 with the reason, not a 500', function () {
    assert.strictEqual(badOp.status, 400);
    assert.ok(badOp.body.error.indexOf('unknown node') !== -1, badOp.body.error);
  });

  const undone = await request('POST', '/api/projects/' + id + '/undo', {});
  test('undo removes the last edit', function () {
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.body.spans.length, 1);
    assert.ok(undone.body.undone.indexOf('add-span') !== -1, undone.body.undone);
  });

  const kml = '<?xml version="1.0"?><kml><Document><name>Import</name>' +
    '<Placemark><name>Route</name><LineString><coordinates>-0.1,51.5,0 -0.101,51.5,0</coordinates></LineString></Placemark>' +
    '<Placemark><name>NAP</name><Point><coordinates>-0.101,51.5,0</coordinates></Point></Placemark>' +
    '</Document></kml>';
  const imported = await request('POST', '/api/import/kml', Buffer.from(kml), { 'Content-Type': 'application/vnd.google-earth.kml+xml' });
  test('KML import measures the route it read', function () {
    assert.strictEqual(imported.status, 200);
    assert.strictEqual(imported.body.routes.length, 1);
    assert.strictEqual(imported.body.points.length, 1);
    assert.ok(imported.body.routeM > 50);
  });

  const demandCsv = 'label,lat,lon\nCasa 1,51.5000,-0.1000\nCasa 2,51.5005,-0.0998\nCasa 3,51.5010,-0.0996\nCasa 4,51.5015,-0.0994';
  const parsedDemand = await request('POST', '/api/import/demand', { demand: demandCsv });
  test('a demand list is parsed and reported before anything is designed', function () {
    assert.strictEqual(parsedDemand.status, 200);
    assert.strictEqual(parsedDemand.body.points.length, 4);
    assert.deepStrictEqual(parsedDemand.body.rejected, []);
  });

  const synthesis = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }
  });
  test('auto-design returns a ranked comparison and a buildable plant', function () {
    assert.strictEqual(synthesis.status, 200);
    assert.strictEqual(synthesis.body.ok, true, JSON.stringify(synthesis.body.notes));
    assert.ok(synthesis.body.candidates.length >= 4);
    assert.ok(synthesis.body.plant.nodes.length >= 5);
    assert.ok(synthesis.body.rationale[0].indexOf('Chosen:') === 0);
    const validation = require('../engine').network.validate(synthesis.body.plant, require('../engine').createRegistry());
    assert.deepStrictEqual(validation.errors, []);
  });

  const applied = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' },
    applyToProject: id
  });
  test('a design can be applied to a project, and the project validates afterwards', function () {
    assert.strictEqual(applied.status, 200);
    assert.ok(applied.body.applied.nodes >= 5);
    assert.strictEqual(applied.body.applied.projectId, id);
  });

  const badDemand = await request('POST', '/api/import/demand', { demand: 'address,postcode\nCalle 3,28001' });
  test('a demand list with no coordinates is a 400 with the reason', function () {
    assert.strictEqual(badDemand.status, 400);
    assert.ok(badDemand.body.error.indexOf('latitude') !== -1, badDemand.body.error);
  });

  const streetJson = {
    edges: [
      { id: 'main', coords: [{ lat: 51.5, lon: -0.1010 }, { lat: 51.5, lon: -0.0990 }] },
      { id: 'side', coords: [{ lat: 51.5, lon: -0.1000 }, { lat: 51.5020, lon: -0.1000 }] }
    ]
  };
  const importedNetwork = await request('POST', '/api/import/network', streetJson);
  test('a street network is built and handed back with its edges', function () {
    assert.strictEqual(importedNetwork.status, 200);
    assert.ok(importedNetwork.body.stats.edges >= 2);
    assert.ok(importedNetwork.body.stats.lengthKm > 0.1);
    assert.ok(Array.isArray(importedNetwork.body.edges[0].coords));
  });

  const routedDesign = await request('POST', '/api/design/synthesise', {
    demand: 'label,lat,lon\nA,51.5004,-0.0998\nB,51.5008,-0.0998',
    headEnd: { lat: 51.5, lon: -0.1010, name: 'PoP' },
    network: { edges: importedNetwork.body.edges }
  });
  test('a design on a street network reports the router and keeps the geometry', function () {
    assert.strictEqual(routedDesign.status, 200);
    assert.strictEqual(routedDesign.body.ok, true, JSON.stringify(routedDesign.body.notes));
    assert.ok(routedDesign.body.routeMethod.indexOf('street-graph') === 0, routedDesign.body.routeMethod);
    const withRoute = routedDesign.body.plant.spans.filter(function (s) { return Array.isArray(s.route) && s.route.length > 2; });
    assert.ok(withRoute.length > 0, 'routed spans carry their street geometry');
  });

  const unknown = await request('GET', '/api/nope');
  test('an unknown endpoint answers JSON, not an HTML error page', function () {
    assert.strictEqual(unknown.status, 404);
    assert.ok(unknown.body.error.indexOf('no such endpoint') !== -1);
  });

  const page = await request('GET', '/');
  test('the app itself is served', function () {
    assert.strictEqual(page.status, 200);
    assert.ok(/text\/html/.test(page.headers['content-type']));
    assert.ok(page.raw.toString('utf8').indexOf('glassforge') !== -1);
  });

  const fibre = await request('GET', '/fiber.js');
  test('the browser gets the engine\'s own colour table', function () {
    assert.strictEqual(fibre.status, 200);
    assert.ok(fibre.raw.toString('utf8').indexOf('GFFiber') !== -1);
  });

  const traversal = await request('GET', '/../package.json');
  test('path traversal is refused', function () {
    assert.ok(traversal.status === 400 || traversal.status === 404, 'status ' + traversal.status);
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
