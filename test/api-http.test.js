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

  // A create names an OLT model, so it can name one that does not exist. This used to answer 201 and
  // save the plant: the very next edit was then refused for "node n1 uses unknown olt model ...",
  // which blames the caller's new op for a typo made in the first one. Every project write is
  // validated before it lands, and the refusal names the models that do exist.
  const badCreate = await request('POST', '/api/projects', { name: 'Typo OLT', olt: 'gpon-c-pluss-8' });
  const afterBadCreate = await request('GET', '/api/projects');
  test('creating a project with an unknown OLT model is a 400 naming the models that exist', function () {
    assert.strictEqual(badCreate.status, 400, JSON.stringify(badCreate.body));
    assert.ok(badCreate.body.error.indexOf('gpon-c-pluss-8') !== -1, badCreate.body.error);
    assert.ok(badCreate.body.error.indexOf('gpon-c-plus-8') !== -1,
      'the refusal must name a model that exists, not only reject the one that does not: ' + badCreate.body.error);
    assert.ok(!afterBadCreate.body.projects.some(function (p) { return p.name === 'Typo OLT'; }),
      'a refused create wrote a project anyway');
  });

  // The name is the other field a create can get wrong and the caller then cannot see. It went to
  // `createProject` unchanged, so `{ name: { a: 1 } }` was a 201 and the printed plan - the page a
  // crew takes to site - titled itself "[object Object] - plan". A name is a string or it is absent.
  const badName = await request('POST', '/api/projects', { name: { a: 1 }, olt: 'gpon-c-plus-8' });
  const afterBadName = await request('GET', '/api/projects');
  test('a project name that is not a string is a 400 naming the field, not a 201', function () {
    assert.strictEqual(badName.status, 400, JSON.stringify(badName.body));
    assert.strictEqual(badName.body.error, 'the project name must be a string, got an object');
    assert.ok(!afterBadName.body.projects.some(function (p) { return typeof p.name !== 'string'; }),
      'a refused create wrote a project anyway: ' + JSON.stringify(afterBadName.body.projects));
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

  // `PUT` merges the body over the stored project and validated the plant, but not the name, so a
  // saved project could be renamed to an array. The undo history does not restore a name, and the
  // print page prints whatever it is given, so the write gate is the only place this can be caught.
  const badRename = await request('PUT', '/api/projects/' + id, { name: ['x'] });
  const reread = await request('GET', '/api/projects/' + id);
  test('a PUT cannot store a name that is not a string', function () {
    assert.strictEqual(badRename.status, 400, JSON.stringify(badRename.body));
    assert.ok(badRename.body.errors.indexOf('the project name must be a string, got an array') !== -1,
      JSON.stringify(badRename.body));
    assert.strictEqual(reread.body.name, 'API test build', 'a refused PUT changed the stored name');
  });

  const budget = await request('POST', '/api/projects/' + id + '/budget', {});
  test('the signal page gets a verdict for every ONT', function () {
    assert.strictEqual(budget.status, 200);
    assert.strictEqual(budget.body.budgets.length, 1);
    const result = budget.body.budgets[0].result;
    assert.ok(['ok', 'marginal', 'fail'].indexOf(result.verdict) !== -1);
    assert.ok(result.breakdown.length >= 4);
  });

  // POST /budget takes a node id. An id that names nothing, or names the OLT, is the caller's mistake:
  // letting designForOnt throw sent it through the generic handler as a 500 - "the server broke" -
  // when the answer is 400 naming the id and the ONT ids that do exist.
  const unknownOnt = await request('POST', '/api/projects/' + id + '/budget', { ontId: 'nope' });
  const notAnOnt = await request('POST', '/api/projects/' + id + '/budget', { ontId: 'n1' });
  test('a budget for an id that is not an ONT is a 400 naming the id, not a 500', function () {
    assert.strictEqual(unknownOnt.status, 400, JSON.stringify(unknownOnt.body));
    assert.ok(unknownOnt.body.error.indexOf('nope') !== -1, unknownOnt.body.error);
    assert.ok(unknownOnt.body.error.indexOf('n3') !== -1,
      'the refusal should name the ONT ids the project does have: ' + unknownOnt.body.error);
    assert.strictEqual(notAnOnt.status, 400, JSON.stringify(notAnOnt.body));
    assert.ok(notAnOnt.body.error.indexOf('n1') !== -1 && /not "ont"/.test(notAnOnt.body.error), notAnOnt.body.error);
  });

  // `ontId` is a *node id*, and the narrowing is decided by truthiness plus a `===` lookup, so any
  // other JSON type was flattened into the lookup or skipped entirely: `[ "n3" ]` concatenated to the
  // string "n3" and the 400 named the ONT the project *has* as missing, `{ id: "n3" }` became
  // "[object Object]", and `0`/`""` are falsy so the caller asked to narrow and got every ONT with a
  // 200. A present value that is not a node id is the caller's field, refused by name before any
  // lookup - the same call `readJsonBody` makes for the body itself.
  const ontIdArray = await request('POST', '/api/projects/' + id + '/budget', { ontId: ['n3'] });
  const ontIdObject = await request('POST', '/api/projects/' + id + '/budget', { ontId: { id: 'n3' } });
  const ontIdZero = await request('POST', '/api/projects/' + id + '/budget', { ontId: 0 });
  const ontIdEmpty = await request('POST', '/api/projects/' + id + '/budget', { ontId: '' });
  test('a budget ontId that is not a node id string is a 400 naming the field, before any lookup', function () {
    // No fibre maths here: the answer depends only on the refusal, so the assertions stay on the
    // status and the sentence.
    for (const [label, res, shape] of [
      ['an array', ontIdArray, 'an array'],
      ['an object', ontIdObject, 'an object'],
      ['a number', ontIdZero, 'a number'],
      ['an empty string', ontIdEmpty, 'an empty string']
    ]) {
      assert.strictEqual(res.status, 400, label + ': ' + JSON.stringify(res.body));
      assert.ok(res.body && res.body.error, label + ': no error sentence');
      assert.ok(res.body.error.indexOf('ontId') !== -1,
        label + ': the refusal must name the field ontId: ' + res.body.error);
      assert.ok(res.body.error.indexOf(shape) !== -1,
        label + ': the refusal must name the shape it got (' + shape + '): ' + res.body.error);
      assert.ok(res.body.error.indexOf('[object Object]') === -1,
        label + ': the shape is hidden behind String(): ' + res.body.error);
    }
    // The array case used to name `n3` as the missing node while listing `n3` as an ONT that exists.
    assert.ok(ontIdArray.body.error.indexOf('has ONTs') === -1,
      'a shape refusal must not be dressed as a missing-node refusal: ' + ontIdArray.body.error);
  });

  // A wavelength the direction cannot carry is the caller's mistake, and it fails every ONT the same
  // way: one 400 naming the rule, not a 200 whose every row repeats the sentence. Upstream at 1550 nm
  // used to be answered as a real verdict - on a 16 km B+ plant, `marginal` where 1310 nm is `fail`.
  const wrongPair = await request('POST', '/api/projects/' + id + '/budget', { direction: 'up', wavelength: '1550' });
  const rightPair = await request('POST', '/api/projects/' + id + '/budget', { direction: 'up', wavelength: '1310' });
  test('a wavelength the direction cannot carry is a 400 naming the rule, once', function () {
    assert.strictEqual(wrongPair.status, 400, JSON.stringify(wrongPair.body));
    assert.ok(wrongPair.body.error.indexOf('upstream is budgeted at 1310 nm, not 1550 nm') !== -1,
      wrongPair.body.error);
    assert.strictEqual(rightPair.status, 200, JSON.stringify(rightPair.body));
    assert.strictEqual(rightPair.body.budgets[0].result.direction, 'up');
    assert.strictEqual(rightPair.body.budgets[0].result.wavelength, '1310');
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

  // A project file can predate the save-time validation (a span with an unknown cable is refused
  // now) or be hand-edited on disk. The BOM must not answer 500 - "the server broke" - for a plant
  // it simply cannot price: it names the span, the way PUT and /ops name it.
  const legacyId = 'plegacy0001';
  fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'projects', legacyId + '.json'), JSON.stringify({
    id: legacyId,
    name: 'Legacy cable',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
      { id: 'n2', type: 'ont', model: 'gpon-ont-4ge', name: 'ONT' }
    ],
    spans: [{ id: 's1', from: 'n1', to: 'n2', cable: 'nope-99', lengthM: 100 }]
  }));
  const legacyBom = await request('GET', '/api/projects/' + legacyId + '/bom');
  test('a stored span with an unknown cable is a 400 naming the span, not a 500', function () {
    assert.strictEqual(legacyBom.status, 400);
    assert.ok(legacyBom.body.error.indexOf('s1') !== -1, legacyBom.body.error);
    assert.ok(legacyBom.body.error.indexOf('nope-99') !== -1, legacyBom.body.error);
  });

  const legacyGet = await request('GET', '/api/projects/' + legacyId);
  test('the same project still opens; only its BOM cannot be priced', function () {
    assert.strictEqual(legacyGet.status, 200);
  });

  // A legacy file can also hold a shape the write gate now refuses: a headend root with a splitter under
  // it. The budget used to walk past the splitter (an active design has no `splitters` field), charge its
  // tail splice and none of its 10.5 dB, and answer a clean verdict on a link ten decibels short. The row
  // for that ONT is now an `error` naming the splitter - 200, because the other ONTs are still budgetable
  // - and never a `result`.
  const activeLegacyId = 'plegacy0002';
  fs.writeFileSync(path.join(dataRoot, 'projects', activeLegacyId + '.json'), JSON.stringify({
    id: activeLegacyId,
    name: 'Legacy active with a splitter',
    nodes: [
      { id: 'h1', type: 'headend', model: 'qsfp28-100g-lr4-10km', name: 'Head end' },
      { id: 'sp1', type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8' },
      { id: 'o1', type: 'ont', model: 'qsfp28-100g-lr4-10km', name: 'Customer' }
    ],
    spans: [
      { id: 's1', from: 'h1', to: 'sp1', cable: 'g652d-loose-12', lengthM: 1000, strands: [1] },
      { id: 's2', from: 'sp1', to: 'o1', cable: 'g652d-loose-12', lengthM: 1000, strands: [2] }
    ]
  }));
  const activeLegacyBudget = await request('POST', '/api/projects/' + activeLegacyId + '/budget', {});
  test('a stored active plant with a splitter answers an error row naming it, not a clean verdict', function () {
    assert.strictEqual(activeLegacyBudget.status, 200, JSON.stringify(activeLegacyBudget.body));
    const row = activeLegacyBudget.body.budgets[0];
    assert.strictEqual(row.ont, 'o1');
    assert.strictEqual(row.result, undefined, 'a refused ONT must not carry a verdict as well');
    assert.ok(/splitter/.test(row.error) && row.error.indexOf('sp1') !== -1, row.error);
  });

  // The PON rule is the PON's: a single-fibre active link runs both directions at its optic's own
  // wavelength, so a 1550 nm circuit budgeted upstream is a real link and must not meet the ONT rule.
  const activeUpId = 'plegacy0003';
  fs.writeFileSync(path.join(dataRoot, 'projects', activeUpId + '.json'), JSON.stringify({
    id: activeUpId,
    name: 'Active 1550 both ways',
    nodes: [
      { id: 'h1', type: 'headend', model: 'sfp-1g-zx-80km', name: 'Head end' },
      { id: 'o1', type: 'ont', model: 'sfp-1g-zx-80km', name: 'Customer' }
    ],
    spans: [{ id: 's1', from: 'h1', to: 'o1', cable: 'g652d-loose-12', lengthM: 1000 }]
  }));
  const activeUp = await request('POST', '/api/projects/' + activeUpId + '/budget', { direction: 'up', wavelength: '1550' });
  test('an active 1550 nm link is budgeted upstream, because that is its own wavelength', function () {
    assert.strictEqual(activeUp.status, 200, JSON.stringify(activeUp.body));
    assert.strictEqual(activeUp.body.budgets[0].result.direction, 'up');
    assert.strictEqual(activeUp.body.budgets[0].result.wavelength, '1550');
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


  // `overlengthPct` is a design slack the engine prices into every cable line, but the synthesise
  // handler forwarded nine named keys and dropped it. Over this socket, 3 and 10 answered the same
  // `designM`, so a caller asking for 10% bought a BOM quoted at 3% - and `overlengthPct: "ten"`
  // answered 200, because the guard that refuses an unreadable value cannot fire on a key the
  // handler never passed on. A BOM number that buys the wrong cable is the caller's loss, silent.
  const shortSlack = await request('POST', '/api/design/synthesise', {
    demand: demandCsv, headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }, overlengthPct: 3
  });
  const longSlack = await request('POST', '/api/design/synthesise', {
    demand: demandCsv, headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }, overlengthPct: 10
  });
  const unreadableSlack = await request('POST', '/api/design/synthesise', {
    demand: demandCsv, headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }, overlengthPct: 'ten'
  });
  test('a design slack reaches the BOM instead of being dropped at the handler', function () {
    assert.strictEqual(shortSlack.status, 200, JSON.stringify(shortSlack.body).slice(0, 200));
    assert.strictEqual(longSlack.status, 200, JSON.stringify(longSlack.body).slice(0, 200));
    const shortM = shortSlack.body.best.metrics.designM;
    const longM = longSlack.body.best.metrics.designM;
    // Each cable line is route x (1 + pct/100), so 10% is 110/103 = 1.068 of the 3% design length.
    assert.ok(shortM > 0 && longM > 0, 'designM ' + shortM + ' and ' + longM);
    const ratio = longM / shortM;
    assert.ok(ratio > 1.05 && ratio < 1.12, '3% and 10% quoted designM ' + shortM + ' and ' + longM);
  });
  test('a slack the design cannot read is a 400 naming the field, not a silent default', function () {
    assert.strictEqual(unreadableSlack.status, 400,
      'status ' + unreadableSlack.status + ': ' + JSON.stringify(unreadableSlack.body).slice(0, 200));
    assert.ok(unreadableSlack.body.error.indexOf('overlengthPct') !== -1, unreadableSlack.body.error);
  });

  // The synthesise handler now hands the design the caller's body, minus its own two keys, so a key
  // the design does not read is the engine's to refuse instead of the handler's to drop. A case slip
  // is the near miss the other purchase-affecting endpoints already refuse by name: `margindb: 40`
  // answered 200 with the 3 dB default (a feasible plant), while `marginDb: 40` refuses this estate -
  // the typo bought the design the caller's own reserve exists to reject.
  const marginTypo = await request('POST', '/api/design/synthesise', {
    demand: demandCsv, headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }, margindb: 40
  });
  const marginWide = await request('POST', '/api/design/synthesise', {
    demand: demandCsv, headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' }, marginDb: 40
  });
  test('a design option spelled one case off is a 400, not the default it meant to replace', function () {
    assert.strictEqual(marginWide.status, 200, JSON.stringify(marginWide.body).slice(0, 200));
    assert.strictEqual(marginWide.body.ok, false, 'a 40 dB reserve leaves this estate with no candidate');
    assert.strictEqual(marginTypo.status, 400, 'status ' + marginTypo.status + ': ' + JSON.stringify(marginTypo.body).slice(0, 200));
    assert.ok(marginTypo.body.error.indexOf('"margindb"') !== -1, marginTypo.body.error);
    assert.ok(marginTypo.body.error.indexOf('did you mean "marginDb"') !== -1, marginTypo.body.error);
  });

  // The cost model is the caller's price list, and a hole in it used to be charged as 0 - a money
  // objective that ranked a design with an unpriced cable as if the cable were free. That is
  // caller input, so it is a 400 naming the cable, not a 500 and not a quiet zero.
  const partialCost = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' },
    costs: { splice: 8, cablePerM: { 'g652d-loose-12': 1.1 } }
  });
  test('a cost model that leaves a cable unpriced is a 400 naming the cable', function () {
    assert.strictEqual(partialCost.status, 400, 'status ' + partialCost.status + ': ' + JSON.stringify(partialCost.body));
    assert.ok(partialCost.body.error.indexOf('costs.cablePerM has no price for') !== -1, partialCost.body.error);
    assert.ok(partialCost.body.error.indexOf('g657a2-drop-2') !== -1, partialCost.body.error);
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

  // `ladder` is the other option the design reads, and the handler dropped it the way it dropped
  // `overlengthPct`: the body named a 48-fibre ladder and the plant still carried
  // g652d-loose-12 on its two trunk spans, so the cable ordered was one the caller excluded.
  const laddered = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' },
    ladder: ['g652d-loose-48']
  });
  const stringLadder = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' },
    ladder: 'g652d-loose-48'
  });
  const unknownLadder = await request('POST', '/api/design/synthesise', {
    demand: demandCsv,
    headEnd: { lat: 51.499, lon: -0.1004, name: 'PoP' },
    ladder: ['g652d-nope']
  });
  test('a cable ladder reaches the design instead of being dropped at the handler', function () {
    assert.strictEqual(laddered.status, 200, JSON.stringify(laddered.body).slice(0, 300));
    const allowed = ['g652d-loose-48', 'g657a2-drop-1', 'g657a2-drop-2'];
    const models = laddered.body.plant.spans.map(function (s) { return s.cable; });
    for (const model of models) {
      assert.ok(allowed.indexOf(model) !== -1, "a span was bought on " + model + ", not the caller's ladder");
    }
    assert.ok(models.indexOf('g652d-loose-48') !== -1, 'the ladder named a cable the trunk did not buy: ' + models.join(', '));
  });
  test('a ladder of the wrong shape, or naming an unknown cable, is a 400 naming the field', function () {
    assert.strictEqual(stringLadder.status, 400, 'status ' + stringLadder.status + ': ' + JSON.stringify(stringLadder.body).slice(0, 200));
    assert.ok(stringLadder.body.error.indexOf('ladder') !== -1, stringLadder.body.error);
    assert.strictEqual(unknownLadder.status, 400, 'status ' + unknownLadder.status + ': ' + JSON.stringify(unknownLadder.body).slice(0, 200));
    assert.ok(unknownLadder.body.error.indexOf('g652d-nope') !== -1, unknownLadder.body.error);
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

  // The JSON form is one of the bodies docs/API.md accepts from this endpoint, and the header is not
  // what makes it JSON: `curl -d` labels the same body application/x-www-form-urlencoded, and a bare
  // fetch body has no type at all. Read only behind a `...json` header, the bytes went to the KML
  // parser and came back `not a KML document: no <kml> root element` - a refusal that named the wrong
  // thing for a body the docs accept. The body is sniffed now: KML starts with `<`, a zip with `PK`.
  const unlabelledJson = await request('POST', '/api/import/network', streetJson, { 'Content-Type': 'text/plain' });
  const formJson = await request('POST', '/api/import/network', streetJson, { 'Content-Type': 'application/x-www-form-urlencoded' });
  test('a JSON street network is read from the body, not from a Content-Type the docs never require', function () {
    assert.strictEqual(unlabelledJson.status, 200, JSON.stringify(unlabelledJson.body));
    assert.strictEqual(unlabelledJson.body.stats.edges, importedNetwork.body.stats.edges);
    assert.strictEqual(formJson.status, 200, JSON.stringify(formJson.body));
    assert.strictEqual(formJson.body.stats.edges, importedNetwork.body.stats.edges);
  });

  const brokenJson = await request('POST', '/api/import/network', Buffer.from('{ "edges": [ '), { 'Content-Type': 'text/plain' });
  test('a JSON body that will not parse names JSON, not the KML parser', function () {
    assert.strictEqual(brokenJson.status, 400, JSON.stringify(brokenJson.body));
    assert.ok(/JSON/.test(brokenJson.body.error), brokenJson.body.error);
    assert.ok(!/KML/i.test(brokenJson.body.error), brokenJson.body.error);
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

  // A design calculator is handed a design by the caller, not a saved project, so a design it cannot
  // use is the caller's mistake: 400 with the field named. A 500 told the caller the server was broken
  // when their request was, which is exactly the confusion `asBadRequest` exists to end.
  const badBudget = await request('POST', '/api/design/budget', { design: {} });
  test('a budget with no OLT is a 400 naming the field, not a 500', function () {
    assert.strictEqual(badBudget.status, 400, 'status ' + badBudget.status + ': ' + JSON.stringify(badBudget.body));
    assert.ok(badBudget.body.error.indexOf('design.olt.model') !== -1, badBudget.body.error);
  });

  // A design field the budget does not read is a typo that costs loss: `splitter` (singular) left the
  // 1:8 splitter out of a 15 km GPON budget and answered 200 with ODN 4.3 dB instead of 14.8 dB.
  // The engine refuses it, and `asBadRequest` is what turns that into a 400 the caller can act on
  // rather than a 500 that blames the server for it.
  const typoBudget = await request('POST', '/api/design/budget', {
    design: {
      olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }], splices: 4, connectors: 2,
      splitter: { model: 'plc-1x8-sca' }
    }
  });
  test('a near-miss design field is a 400 naming the field that was meant', function () {
    assert.strictEqual(typoBudget.status, 400, 'status ' + typoBudget.status + ': ' + JSON.stringify(typoBudget.body));
    assert.ok(typoBudget.body.error.indexOf('"splitter"') !== -1, typoBudget.body.error);
    assert.ok(typoBudget.body.error.indexOf('splitters') !== -1, typoBudget.body.error);
  });

  // A swapped adjacent pair is one keystroke, so it is one edit: `marignDb: 10` answered 200 with
  // `marginDb` 3 before the matcher counted a transposition as one (#25, #27) - the 10 dB reserve,
  // the one that turns a `marginal` link into a refusal, silently dropped.
  const swappedMargin = await request('POST', '/api/design/budget', {
    design: {
      olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }], splitters: [{ model: 'plc-1x8-sca' }],
      marignDb: 10
    }
  });
  const spelledMargin = await request('POST', '/api/design/budget', {
    design: {
      olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }], splitters: [{ model: 'plc-1x8-sca' }],
      marginDb: 10
    }
  });
  test('a swapped pair in a design field is a 400, and the spelled field is read', function () {
    assert.strictEqual(spelledMargin.status, 200, JSON.stringify(spelledMargin.body).slice(0, 200));
    assert.strictEqual(spelledMargin.body.marginDb, 10, 'the reserve the caller spelled is the one budgeted');
    assert.strictEqual(swappedMargin.status, 400, 'status ' + swappedMargin.status + ': ' + JSON.stringify(swappedMargin.body).slice(0, 200));
    assert.ok(swappedMargin.body.error.indexOf('"marignDb"') !== -1, swappedMargin.body.error);
    assert.ok(swappedMargin.body.error.indexOf('did you mean "marginDb"') !== -1, swappedMargin.body.error);
  });

  // A launch power written inside the end object is the shape the engine's own doc block advertised
  // (`olt { model, txDbm? }`) and has never read: it budgeted at the transmitter's minimum and answered
  // 200 - on this 15 km design, -13.30 dBm instead of -9.80 dBm, 3.50 dB optimistic. A refusal the
  // caller can act on names both the path that arrived and the field that works, and `asBadRequest`
  // makes it a 400 rather than a 500.
  const nestedLaunch = await request('POST', '/api/design/budget', {
    design: {
      olt: { model: 'gpon-b-plus-8', txDbm: 5 }, ont: { model: 'gpon-ont-1ge' },
      spans: [{ cable: 'g652d-loose-12', lengthM: 15000 }], splitters: [{ model: 'plc-1x8-sca' }]
    }
  });
  test('a launch power inside the end object is a 400 naming the field that works', function () {
    assert.strictEqual(nestedLaunch.status, 400, 'status ' + nestedLaunch.status + ': ' + JSON.stringify(nestedLaunch.body));
    assert.ok(nestedLaunch.body.error.indexOf('design.olt.txDbm') !== -1, nestedLaunch.body.error);
    assert.ok(nestedLaunch.body.error.indexOf('"txDbm"') !== -1, nestedLaunch.body.error);
  });

  // The other half of that: a field the budget *does* read, holding a value it cannot use. `marginDb`
  // is the reserve the headroom test is measured against, so `-5` passes every link that is 2.2 dB
  // short of the 3 dB default - it answered 200 `marginal` for a design that is `fail` untouched, and
  // on a project it answered 200 with the same sentence in every ONT's row instead of one refusal.
  const tightDesign = {
    olt: { model: 'gpon-b-plus-8' }, ont: { model: 'gpon-ont-1ge' }, wavelength: '1490',
    spans: [{ cable: 'g652d-loose-96', lengthM: 20000 }], splitters: [{ model: 'plc-1x64-sca' }],
    splices: 10, connectors: 6
  };
  const tightPlain = await request('POST', '/api/design/budget', { design: tightDesign });
  const negativeMargin = await request('POST', '/api/design/budget', {
    design: Object.assign({}, tightDesign, { marginDb: -5 })
  });
  const projectNegativeMargin = await request('POST', '/api/projects/' + id + '/budget', { marginDb: -5 });
  test('a reserve that is not a reserve is a 400 on both budget endpoints', function () {
    assert.strictEqual(tightPlain.status, 200);
    assert.strictEqual(tightPlain.body.verdict, 'fail', 'the baseline design is a failure to begin with');
    assert.strictEqual(negativeMargin.status, 400, 'status ' + negativeMargin.status + ': ' + JSON.stringify(negativeMargin.body));
    assert.ok(negativeMargin.body.error.indexOf('marginDb') !== -1, negativeMargin.body.error);
    assert.strictEqual(projectNegativeMargin.status, 400,
      'status ' + projectNegativeMargin.status + ': ' + JSON.stringify(projectNegativeMargin.body));
    assert.ok(projectNegativeMargin.body.error.indexOf('marginDb') !== -1, projectNegativeMargin.body.error);
  });

  // The project budget reads eight keys off the body and hands it to `designForOnt`. A near miss of one
  // of them is the same defect the design budget refuses by name, one endpoint over: `margindb: 40`
  // answered 200 with `marginDb: 3` echoed, so a link short of the reserve the caller asked for came
  // back `ok` - the typo removed a requirement without removing a number from the answer.
  const typoProjectMargin = await request('POST', '/api/projects/' + id + '/budget', { margindb: 6 });
  const bookkeeping = await request('POST', '/api/projects/' + id + '/budget', {
    notes: 'surveyed 2026-11-19', name: 'west estate'
  });
  test('a near-miss budget field is a 400 on the project budget too', function () {
    assert.strictEqual(typoProjectMargin.status, 400,
      'status ' + typoProjectMargin.status + ': ' + JSON.stringify(typoProjectMargin.body));
    assert.ok(typoProjectMargin.body.error.indexOf('"margindb"') !== -1, typoProjectMargin.body.error);
    assert.ok(typoProjectMargin.body.error.indexOf('marginDb') !== -1, typoProjectMargin.body.error);
    // The refusal stays narrow: a key that is not a near miss of one the budget reads is still ignored,
    // because refusing every unknown key would refuse a caller who is not wrong.
    assert.strictEqual(bookkeeping.status, 200,
      'status ' + bookkeeping.status + ': ' + JSON.stringify(bookkeeping.body));
  });

  // A JSON body of `null` is valid JSON and is what a client sends when it has no object to send.
  // Every handler reads a field off the body, so the first access threw a TypeError and the generic
  // handler answered 500 "Cannot read properties of null (reading 'demand')" - the caller was told
  // the server broke when the request was the thing that was wrong. A body that is not an object has
  // no fields, so it is refused once, at the door, naming what arrived.
  const nullBodyCreate = await request('POST', '/api/projects', null);
  const nullBodyDemand = await request('POST', '/api/import/demand', null);
  const nullBodySynthesis = await request('POST', '/api/design/synthesise', null);
  test('a null JSON body is a 400 naming the body, not a 500 TypeError', function () {
    [nullBodyCreate, nullBodyDemand, nullBodySynthesis].forEach(function (answer) {
      assert.strictEqual(answer.status, 400, 'status ' + answer.status + ': ' + JSON.stringify(answer.body));
      assert.strictEqual(answer.body.error, 'the request body must be a JSON object, got null');
    });
  });

  // A projection or a bare CSV line can tempt a caller into posting `[ ... ]`; the endpoints all
  // take named fields, so an array is the same mistake as `null` and gets the same answer.
  const arrayBody = await request('POST', '/api/design/length', [{ lat: 51.5, lon: -0.1 }]);
  test('an array body is refused as "not an object", not read as one', function () {
    assert.strictEqual(arrayBody.status, 400, 'status ' + arrayBody.status + ': ' + JSON.stringify(arrayBody.body));
    assert.ok(arrayBody.body.error.indexOf('got an array') !== -1, arrayBody.body.error);
  });

  const badLength = await request('POST', '/api/design/length', {});
  const goodLength = await request('POST', '/api/design/length', { routeM: 3000 });
  test('a cable calculation with no route is a 400, and a real one still answers', function () {
    assert.strictEqual(badLength.status, 400, 'status ' + badLength.status + ': ' + JSON.stringify(badLength.body));
    assert.ok(badLength.body.error.indexOf('routeM') !== -1, badLength.body.error);
    // 3.0 km + 3% overlength = 3090 m, which is two 2000 m drums
    assert.strictEqual(goodLength.status, 200);
    assert.strictEqual(goodLength.body.designM, 3090);
    assert.strictEqual(goodLength.body.drums, 2);
  });

  // The cable calculation reads nine named options, and a near miss of one was not read at all: the
  // 200 answered the default and the purchase order was computed without the term the caller named.
  // `{"routeM":1000,"drumm":500}` bought 2000 m of a 2000 m drum where the caller asked for 3 x 500,
  // and `{"routeM":1000,"overlengthpct":10}` answered `designM` 1030 instead of 1100. Same near-miss
  // rule the budget endpoints refuse by name (#137, #192), applied where the money is spent.
  const typoDrum = await request('POST', '/api/design/length', { routeM: 1000, drumm: 500 });
  const typoOverlength = await request('POST', '/api/design/length', { routeM: 1000, overlengthpct: 10 });
  // A swap is one keystroke: `overlenghtPct` answered 1030 m (the 3% default) where 1100 m was asked.
  const typoSwapped = await request('POST', '/api/design/length', { routeM: 1000, overlenghtPct: 10 });
  test('a near-miss option on the cable calculation is a 400 naming the field', function () {
    assert.strictEqual(typoDrum.status, 400, 'status ' + typoDrum.status + ': ' + JSON.stringify(typoDrum.body));
    assert.ok(typoDrum.body.error.indexOf('did you mean "drumM"') !== -1, typoDrum.body.error);
    assert.strictEqual(typoOverlength.status, 400, 'status ' + typoOverlength.status + ': ' + JSON.stringify(typoOverlength.body));
    assert.ok(typoOverlength.body.error.indexOf('did you mean "overlengthPct"') !== -1, typoOverlength.body.error);
    assert.strictEqual(typoSwapped.status, 400, 'status ' + typoSwapped.status + ': ' + JSON.stringify(typoSwapped.body).slice(0, 200));
    assert.ok(typoSwapped.body.error.indexOf('did you mean "overlengthPct"') !== -1, typoSwapped.body.error);
  });

  // The route form of the same endpoint had no measured length and said nothing: `{"points":[]}`
  // answered 200 with `routeM: 0, drums: 0, purchaseM: 0` - a purchase order for nothing. A caller's
  // mistake is a 400 (see AGENTS.md), and it names what a route needs.
  const noRoutePoints = await request('POST', '/api/design/length', { points: [] });
  test('a route with no points is a 400, not a zero-metre BOM', function () {
    assert.strictEqual(noRoutePoints.status, 400, 'status ' + noRoutePoints.status + ': ' + JSON.stringify(noRoutePoints.body));
    assert.ok(noRoutePoints.body.error.indexOf('at least two') !== -1, noRoutePoints.body.error);
  });

  // The body limit is mapped to a 413, and that status used to be unreachable: `readBody` answered an
  // over-limit body by destroying the request, which tears down the socket the refusal has to travel
  // on. The caller's next read was ECONNRESET ("socket hang up"), so an upload that was merely too
  // big looked like a dead server and the reason - `request body exceeds 2097152 bytes` - was never
  // said. 2 MiB + 1 KiB is over the JSON limit and nowhere near the 25 MiB upload limit.
  let oversizeAnswer = null;
  try {
    oversizeAnswer = await request('POST', '/api/projects', Buffer.alloc(2 * 1024 * 1024 + 1024, 0x78));
  } catch (err) {
    oversizeAnswer = { dropped: err };
  }
  test('a body over the limit is a 413 naming the limit, not a dropped socket', function () {
    assert.ok(!oversizeAnswer.dropped,
      'the request was dropped instead of refused: ' + (oversizeAnswer.dropped && (oversizeAnswer.dropped.code || oversizeAnswer.dropped.message)));
    assert.strictEqual(oversizeAnswer.status, 413,
      'status ' + oversizeAnswer.status + ': ' + JSON.stringify(oversizeAnswer.body));
    // 2 MiB is MAX_BODY_BYTES: the sentence has to carry the number the caller has to get under.
    assert.ok(oversizeAnswer.body.error.indexOf('2097152') !== -1, oversizeAnswer.body.error);
  });

  // #179 made the 413 reachable, but it was still written the instant the body crossed the limit -
  // and a response written while megabytes of the upload are still inbound closes the socket with
  // data in its receive buffer, which the kernel answers with RST. The caller then throws away the
  // 413 it was just sent and reports ECONNRESET ("socket hang up"): measured on that version, 3 of
  // 10 x 2.5 MiB uploads to `/api/projects` lost the refusal, and 10 MiB lost it about half the time.
  // The refusal now waits for the upload to finish arriving (the rest is read and discarded, not
  // buffered), so this test asserts the order rather than the race: nothing is answered while the
  // declared body is still in flight, and the 413 with its limit arrives when it ends.
  const declared = 3 * 1024 * 1024;
  const uploadBody = Buffer.alloc(declared, 0x78);
  let answeredMidUpload = false;
  let uploadEnded = false;
  const finishedUpload = await new Promise(function (resolve) {
    const upReq = http.request(base + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': uploadBody.length }
    }, function (res) {
      if (!uploadEnded) answeredMidUpload = true;
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, connection: res.headers.connection, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    upReq.on('error', function (err) { resolve({ dropped: err.code }); });
    // 2 MiB + 1 KiB is over the limit; the last megabyte is held back, so the server sees an
    // over-limit body with a declared remainder still to come.
    upReq.write(uploadBody.slice(0, 2 * 1024 * 1024 + 1024), function () {
      setTimeout(function () {
        uploadEnded = true;
        upReq.end(uploadBody.slice(2 * 1024 * 1024 + 1024));
      }, 200).unref();
    });
  });
  test('the 413 waits for the upload to finish, so the refusal is not lost to a TCP reset', function () {
    assert.strictEqual(answeredMidUpload, false,
      'the server answered while the declared body was still arriving - that close is the reset the caller loses the 413 to');
    assert.ok(!finishedUpload.dropped, 'the refusal was lost to ' + finishedUpload.dropped);
    assert.strictEqual(finishedUpload.status, 413,
      'status ' + finishedUpload.status + ': ' + finishedUpload.text);
    assert.strictEqual(finishedUpload.connection, 'close');
    // 2097152 is MAX_BODY_BYTES: the caller is told the number it has to get under.
    assert.ok(finishedUpload.text.indexOf('2097152') !== -1, finishedUpload.text);
  });

  // The limit is not one number for every endpoint, and docs/API.md names both: 2 MiB for a design or
  // project body, 25 MiB for the five that carry a demand list or a street/duct graph (a duct graph is
  // a whole KML, and an estate is thousands of rows, so the smaller limit would refuse real work).
  // Asserted from both sides so the paragraph cannot drift back to "2 MiB for a JSON body": the same
  // 2.5 MiB valid JSON is refused on `/api/design/budget` and reaches the handler on
  // `/api/design/synthesise`, which answers about its missing `demand` rather than its size.
  const twoAndAHalf = Buffer.from(JSON.stringify({ pad: 'x'.repeat(Math.round(2.5 * 1024 * 1024)) }));
  const smallLimit = await request('POST', '/api/design/budget', twoAndAHalf);
  const bigLimit = await request('POST', '/api/design/synthesise', twoAndAHalf);
  test('the 2 MiB limit is a JSON body limit; the endpoints that carry a graph or a demand list take 25 MiB', function () {
    assert.strictEqual(smallLimit.status, 413,
      'status ' + smallLimit.status + ': ' + JSON.stringify(smallLimit.body));
    assert.ok(smallLimit.body.error.indexOf('2097152') !== -1, smallLimit.body.error);
    assert.strictEqual(bigLimit.status, 400,
      'status ' + bigLimit.status + ': ' + JSON.stringify(bigLimit.body));
    assert.ok(bigLimit.body.error.indexOf('demand is required') !== -1,
      'the body was refused for its size instead of reaching the handler: ' + bigLimit.body.error);
  });

  const splitOk = await request('GET', '/api/design/splitter?ratio=8');
  const splitZero = await request('GET', '/api/design/splitter?ratio=0');
  const splitText = await request('GET', '/api/design/splitter?ratio=abc');
  const splitEmpty = await request('GET', '/api/design/splitter?ratio=');
  test('a split ratio that is not a positive integer is refused, not answered with null', function () {
    assert.strictEqual(splitOk.status, 200);
    assert.strictEqual(splitOk.body.idealSplitLossDb, 9.03, '10 x log10(8) = 9.03 dB');
    // JSON.stringify(-Infinity) is `null`: the old endpoint answered 200 with a null loss figure,
    // and `Number('')` is 0, so an empty parameter became a 1:0 splitter.
    for (const bad of [splitZero, splitText, splitEmpty]) {
      assert.strictEqual(bad.status, 400, 'status ' + bad.status + ': ' + JSON.stringify(bad.body));
      assert.ok(bad.body.error.indexOf('ratio') !== -1, bad.body.error);
    }
  });

  const notKml = await request('POST', '/api/import/kml', Buffer.from('definitely not a kml document'), { 'Content-Type': 'text/plain' });
  test('a file that is not KML is a 400, the same answer the network importer gives', function () {
    assert.strictEqual(notKml.status, 400, 'status ' + notKml.status + ': ' + JSON.stringify(notKml.body));
    assert.ok(/kml/i.test(notKml.body.error), notKml.body.error);
  });

  // A KMZ is a zip the caller uploads. Bytes that are not a zip are the caller's mistake, exactly like
  // text that is not KML - and `/api/import/kml` already answers 400 for them. The network importer
  // decoded the same bytes outside its try, so the zip parser's sentence ("not a zip archive...")
  // reached the generic handler and came back as 500: the caller was told the server had broken when
  // their file had. Two importers, one contract.
  const corruptKmz = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not a zip archive')]);
  const badKmzKml = await request('POST', '/api/import/kml', corruptKmz, { 'Content-Type': 'application/vnd.google-earth.kmz' });
  const badKmzNetwork = await request('POST', '/api/import/network', corruptKmz, { 'Content-Type': 'application/vnd.google-earth.kmz' });
  test('an undecodable KMZ is a 400 from both importers, not a 500', function () {
    assert.strictEqual(badKmzKml.status, 400, 'status ' + badKmzKml.status + ': ' + JSON.stringify(badKmzKml.body));
    assert.strictEqual(badKmzNetwork.status, 400,
      'status ' + badKmzNetwork.status + ': ' + JSON.stringify(badKmzNetwork.body));
    assert.ok(/zip/i.test(badKmzNetwork.body.error), badKmzNetwork.body.error);
    assert.strictEqual(badKmzNetwork.body.error, badKmzKml.body.error,
      'the two importers must give the same reason for the same bytes');
  });

  const linkGrid = { edges: [
    { id: 'north', coords: [{ lat: 51.5010, lon: -0.1020 }, { lat: 51.5010, lon: -0.0960 }] },
    { id: 'south', coords: [{ lat: 51.4995, lon: -0.1020 }, { lat: 51.4995, lon: -0.0960 }] },
    { id: 'a-north', coords: [{ lat: 51.5, lon: -0.1020 }, { lat: 51.5010, lon: -0.1020 }] },
    { id: 'a-south', coords: [{ lat: 51.5, lon: -0.1020 }, { lat: 51.4995, lon: -0.1020 }] },
    { id: 'b-north', coords: [{ lat: 51.5, lon: -0.0960 }, { lat: 51.5010, lon: -0.0960 }] },
    { id: 'b-south', coords: [{ lat: 51.5, lon: -0.0960 }, { lat: 51.4995, lon: -0.0960 }] }
  ] };
  const dcLink = await request('POST', '/api/design/link', {
    sites: { a: { name: 'DC-West', lat: 51.5, lon: -0.1020 }, b: { name: 'DC-East', lat: 51.5, lon: -0.0960 } },
    network: linkGrid,
    optics: { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' }
  });
  test('POST /api/design/link returns a routed, diverse circuit', function () {
    assert.strictEqual(dcLink.status, 200);
    assert.strictEqual(dcLink.body.ok, true, JSON.stringify(dcLink.body.reasons));
    assert.strictEqual(dcLink.body.legs.length, 2);
    assert.strictEqual(dcLink.body.diversity.sharedM, 0);
    assert.ok(dcLink.body.routeMethod.indexOf('street-graph') === 0, dcLink.body.routeMethod);
    assert.strictEqual(dcLink.body.bom.thirdParty.inCableBom, false);
  });

  const badLink = await request('POST', '/api/design/link', { sites: { a: { lat: 51.5, lon: -0.1 } } });
  test('a link with one end is a 400 that says which end is missing', function () {
    assert.strictEqual(badLink.status, 400);
    assert.ok(badLink.body.error.indexOf('sites.b') !== -1, badLink.body.error);  });

  // A near-miss option on the link is the caller's mistake, so it is a 400 naming the field - not a
  // 200 that quoted the 3% default overlength, and not a 500 blaming the server.
  const typoLink = await request('POST', '/api/design/link', {
    sites: { a: { name: 'DC-West', lat: 51.5, lon: -0.1020 }, b: { name: 'DC-East', lat: 51.5, lon: -0.0960 } },
    network: linkGrid,
    optics: { a: 'sfp-plus-10g-er-40km', b: 'sfp-plus-10g-er-40km' },
    overlengthpct: 10
  });
  test('a near-miss link option is a 400 naming the field, not a defaulted BOM', function () {
    assert.strictEqual(typoLink.status, 400);
    assert.ok(typoLink.body.error.indexOf('overlengthPct') !== -1, typoLink.body.error);
  });

  // ---- the printed plan ------------------------------------------------------
  // A crew gets paper: the plan drawing with a scale bar, the cable to buy, the splice schedule and
  // the warnings. It is HTML so a browser can save it as PDF with no export library.

  const printProject = await request('POST', '/api/projects', { name: 'Print <script>alert(1)</script> & sons' });
  const printId = printProject.body.id;
  let printed = await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT-Central', lat: 51.5, lon: -0.1 }
  });
  const printOlt = printed.body.nodes.find(function (n) { return n.type === 'olt'; }).id;
  printed = await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-node', node: { type: 'closure', model: 'inline-closure-24', name: 'NAP-1', lat: 51.5005, lon: -0.0998 }
  });
  const printClosure = printed.body.nodes.find(function (n) { return n.type === 'closure'; }).id;
  printed = await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'House 1', lat: 51.501, lon: -0.0995 }
  });
  const printOnt = printed.body.nodes.find(function (n) { return n.type === 'ont'; }).id;
  printed = await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-node', node: { type: 'closure', model: 'inline-closure-24', name: 'NAP-Orphan', lat: 51.4995, lon: -0.1005 }
  });
  await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-span', span: { from: printOlt, to: printClosure, cable: 'g652d-loose-12', lengthM: 800, strands: [1, 2, 3] }
  });
  await request('POST', '/api/projects/' + printId + '/ops', {
    op: 'add-span', span: { from: printClosure, to: printOnt, cable: 'g657a2-drop-2', lengthM: 45, strands: [2, 3] }
  });

  const printPage = await request('GET', '/print/project/' + printId);
  const printHtml = printPage.raw.toString('utf8');
  test('GET /print/project/:id is a printable page with the plan, the BOM and the splice schedule', function () {
    assert.strictEqual(printPage.status, 200);
    assert.ok(/text\/html/.test(printPage.headers['content-type']), printPage.headers['content-type']);
    assert.ok(printHtml.indexOf('<svg') !== -1, 'the plan drawing must be on the page');
    assert.ok(printHtml.indexOf('Cable to buy') !== -1, 'no cable table');
    assert.ok(printHtml.indexOf('g652d-loose-12') !== -1, 'the BOM does not name the cable to buy');
    assert.ok(printHtml.indexOf('Splice schedule') !== -1, 'no splice schedule');
    assert.ok(printHtml.indexOf('T01-F01') !== -1, 'the splice schedule has no TIA-598 address');
    assert.ok(printHtml.indexOf('1 px =') !== -1, 'the drawing must state its scale');
    assert.ok(printHtml.indexOf('not connected') !== -1, 'the validation warnings are missing');
  });

  test('the printed page escapes the project name and loads nothing from outside', function () {
    assert.ok(printHtml.indexOf('Print &lt;script&gt;alert(1)&lt;/script&gt; &amp; sons') !== -1,
      'the project name was not HTML-escaped');
    assert.ok(printHtml.indexOf('<script>alert(1)') === -1, 'the project name executed as markup');
    assert.ok(printHtml.indexOf('<script') === -1, 'the print page must not need a script');
    assert.ok(printHtml.indexOf('src="http') === -1 && printHtml.indexOf('href="http') === -1,
      'a printed plan must render with no network access');
  });

  // A splitter on the printed sheet. The engine's rows are asserted directly in print-export; this
  // drives the page a crew actually gets, because the wording there is the claim in docs/API.md.
  const splitProject = await request('POST', '/api/projects', { name: 'Splitter plan' });
  let splitState = await request('POST', '/api/projects/' + splitProject.body.id + '/ops', {
    op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 }
  });
  const splitOlt = splitState.body.nodes.find(function (n) { return n.type === 'olt'; }).id;
  splitState = await request('POST', '/api/projects/' + splitProject.body.id + '/ops', {
    op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'SPL 1:8', lat: 51.5005, lon: -0.1 }
  });
  const splitSplitter = splitState.body.nodes.find(function (n) { return n.type === 'splitter'; }).id;
  splitState = await request('POST', '/api/projects/' + splitProject.body.id + '/ops', {
    op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'House 1', lat: 51.501, lon: -0.1 }
  });
  const splitOnt = splitState.body.nodes.find(function (n) { return n.type === 'ont'; }).id;
  splitState = await request('POST', '/api/projects/' + splitProject.body.id + '/ops', {
    op: 'add-span', span: { from: splitOlt, to: splitSplitter, cable: 'g652d-loose-12', lengthM: 500, strands: [1] }
  });
  const feederSpan = splitState.body.spans[0].id;
  // A two-fibre drop: the splitter's two ports feed strands 1 and 2, and a 1-fibre drop would be a
  // span listing more strands than its cable carries - overbooked, and refused by the save gate.
  splitState = await request('POST', '/api/projects/' + splitProject.body.id + '/ops', {
    op: 'add-span', span: { from: splitSplitter, to: splitOnt, cable: 'g657a2-drop-2', lengthM: 40, strands: [1, 2] }
  });
  const dropSpan = splitState.body.spans[1].id;
  const splitPrint = await request('GET', '/print/project/' + splitProject.body.id);

  test('the printed splitter schedule names input and ports, never a splice across the split', function () {
    const html = splitPrint.raw.toString('utf8');
    assert.ok(html.indexOf('splitter input (1 splice)') !== -1, 'the feeder strand is not shown terminated on the splitter');
    assert.ok(html.indexOf('splitter port P1') !== -1 && html.indexOf('splitter port P2') !== -1,
      'the distribution strands are not numbered as splitter ports');
    assert.ok(html.indexOf('1:8') !== -1, 'the sheet does not print the split ratio');
    // The splitter's own table must not name either neighbouring cable as a joint: that row is the
    // mis-wiring this schedule exists to prevent.
    // The node name is also drawn in the plan SVG, so the section is taken from the schedule heading.
    const heading = html.indexOf('Splice schedule');
    const start = html.indexOf('SPL 1:8', heading);
    const end = html.indexOf('</table>', start);
    const splitterSection = html.slice(start, end);
    assert.ok(splitterSection.indexOf('>' + feederSpan + '<') !== -1, 'the feeder cable is missing from the splitter table');
    splitterSection.split('<tr>').slice(1).forEach(function (row) {
      const cells = row.split('<td');
      const joints = cells[cells.length - 1];
      assert.ok(joints.indexOf(feederSpan) === -1 && joints.indexOf(dropSpan) === -1,
        'a splitter row claims a joint to another cable: ' + joints);
    });
  });

  const emptyProject = await request('POST', '/api/projects', { name: 'Empty plan' });
  const emptyPrint = await request('GET', '/print/project/' + emptyProject.body.id);
  test('an empty project still prints: zero counts, no crash, no invented cable', function () {
    assert.strictEqual(emptyPrint.status, 200);
    const html = emptyPrint.raw.toString('utf8');
    assert.ok(html.indexOf('no spans') !== -1, 'an empty plant should say so rather than print an empty table');
    assert.ok(html.indexOf('<svg') !== -1, 'the plan area is still drawn');
  });

  const missingPrint = await request('GET', '/print/project/does-not-exist');
  test('printing an unknown project is a 404 page, not a stack trace', function () {
    assert.strictEqual(missingPrint.status, 404);
    assert.ok(/text\/html/.test(missingPrint.headers['content-type']));
    assert.ok(missingPrint.raw.toString('utf8').indexOf('not found') !== -1);
  });

  // A URL the caller mistyped is caller input, and docs/API.md says bad input is a 400 and a 500
  // means the server broke. `decodeURIComponent` on a truncated escape throws URIError, which the
  // generic handler used to dress up as `500 URI malformed` plus a stack trace - sending a script
  // author to look for a server fault that is not there. The refusal names the path it could not read.
  const badEscape = await request('GET', '/api/parts/cable/%E0%A4%A');
  test('a path that is not valid percent-encoding is a 400 naming the path, not a 500', function () {
    assert.strictEqual(badEscape.status, 400);
    assert.ok(String(badEscape.body.error).indexOf('percent-encoding') !== -1,
      'the refusal must say what is wrong with the path, got: ' + JSON.stringify(badEscape.body));
    assert.ok(String(badEscape.body.error).indexOf('/api/parts/cable/%E0%A4%A') !== -1,
      'the refusal must name the path it could not read, got: ' + JSON.stringify(badEscape.body));
  });

  const afterBadEscape = await request('GET', '/api/health');
  test('one unreadable path does not take the server down for the next request', function () {
    assert.strictEqual(afterBadEscape.status, 200);
  });

  const unknown = await request('GET', '/api/nope');
  test('an unknown endpoint answers JSON, not an HTML error page', function () {
    assert.strictEqual(unknown.status, 404);
    assert.ok(unknown.body.error.indexOf('no such endpoint') !== -1);
  });

  // docs/API.md line 5 promises `405` for a wrong method and `404` for an unknown thing. The
  // fallthrough answered every wrong method with `404 no such endpoint` - including
  // `GET /api/design/synthesise`, a URL a caller has just read in the docs - and the two endpoints
  // that never looked at the method at all (health, parts) answered `POST` with a 200. A path that
  // exists with the wrong method must say which methods it does answer.
  const postHealth = await request('POST', '/api/health');
  test('POST to a GET-only endpoint is a 405 naming the methods it answers, not a 200', function () {
    assert.strictEqual(postHealth.status, 405);
    assert.strictEqual(postHealth.headers.allow, 'GET, HEAD');
    assert.ok(String(postHealth.body.error).indexOf('/api/health') !== -1,
      'the refusal must name the path, got: ' + JSON.stringify(postHealth.body));
    assert.ok(String(postHealth.body.error).indexOf('GET') !== -1,
      'the refusal must name the method it does answer, got: ' + JSON.stringify(postHealth.body));
  });

  const deleteParts = await request('DELETE', '/api/parts');
  test('a wrong method on the catalogue is a 405, not a 404 saying the endpoint does not exist', function () {
    assert.strictEqual(deleteParts.status, 405);
    assert.strictEqual(deleteParts.headers.allow, 'GET, HEAD');
    assert.ok(String(deleteParts.body.error).indexOf('no such endpoint') === -1,
      'the endpoint exists; calling it unknown sends the caller hunting a URL that is in the docs');
  });

  const getSynthesise = await request('GET', '/api/design/synthesise');
  test('a POST-only endpoint refuses GET with a 405 and allow: POST', function () {
    assert.strictEqual(getSynthesise.status, 405);
    assert.strictEqual(getSynthesise.headers.allow, 'POST');
  });

  const postBom = await request('POST', '/api/projects/' + emptyProject.body.id + '/bom');
  const getOps = await request('GET', '/api/projects/' + emptyProject.body.id + '/ops');
  test('a project sub-resource answers 405 for the wrong method and names what it takes', function () {
    assert.strictEqual(postBom.status, 405);
    assert.strictEqual(postBom.headers.allow, 'GET, HEAD');
    assert.strictEqual(getOps.status, 405);
    assert.strictEqual(getOps.headers.allow, 'POST');
  });

  const getSplitterPost = await request('POST', '/api/design/splitter?ratio=8');
  const getSplitterGet = await request('GET', '/api/design/splitter?ratio=8');
  test('the splitter ratio is a GET (9.03 dB for 1:8) and POST to it is refused', function () {
    assert.strictEqual(getSplitterGet.status, 200);
    assert.strictEqual(getSplitterGet.body.idealSplitLossDb, 9.03); // 10*log10(8) = 9.0309 -> 9.03
    assert.strictEqual(getSplitterPost.status, 405);
    assert.strictEqual(getSplitterPost.headers.allow, 'GET, HEAD');
  });

  const unknownAction = await request('GET', '/api/projects/' + emptyProject.body.id + '/nope');
  test('an unknown project sub-resource is a 404, not a 405 for a method nobody can pick', function () {
    assert.strictEqual(unknownAction.status, 404);
    assert.ok(String(unknownAction.body.error).indexOf('no such endpoint') !== -1);
  });

  const headParts = await request('HEAD', '/api/parts');
  test('HEAD follows GET on an endpoint that has one', function () {
    assert.strictEqual(headParts.status, 200);
    assert.strictEqual(headParts.headers.allow, undefined, 'a HEAD that is allowed is a 200, not a 405');
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

  // A plain '/../package.json' is rewritten to '/package.json' by the client before the handler ever
  // sees it, and then 404s because web/package.json does not exist - an unrelated reason that proves
  // nothing about the guard. The traversal that actually reaches serveStatic is the encoded one.
  const plainTraversal = await request('GET', '/../package.json');
  const traversal = await request('GET', '/..%2fpackage.json');
  test('path traversal is refused', function () {
    assert.strictEqual(plainTraversal.status, 404, 'plain /../ is normalised away before the handler');
    assert.strictEqual(traversal.status, 400, 'an encoded .. must be refused by the handler, got ' + traversal.status);
    assert.ok(traversal.body && String(traversal.body.error).indexOf('bad path') !== -1,
      'the refusal should name the path, got: ' + JSON.stringify(traversal.body));
    const served = traversal.raw.toString('utf8');
    assert.ok(served.indexOf('"glassforge"') === -1 && served.indexOf('"dependencies"') === -1,
      'a file outside web/ was served: ' + served.slice(0, 120));
  });

  // The endpoint answers ONE row shape: `{ ont, name, result }` or `{ ont, name, error }`, with
  // `ont` the node id. With `ontId` it used to hand back the bare budget result instead - no row
  // wrapper, `ont` holding the ONT *model*, and a refusal the list call reports as an error row
  // escaping the handler as a 500. A single-ONT call is the same answer with one row in it.
  const ids = applied.body.plant.nodes.filter(function (n) { return n.type === 'ont'; }).map(function (n) { return n.id; });
  const firstOnt = ids[0];
  const orphan = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Sin acometida' }
  });
  const orphanId = orphan.body.nodes[orphan.body.nodes.length - 1].id;
  test('an ONT with no span yet is a warning, not a refused edit', function () {
    assert.strictEqual(orphan.status, 200, JSON.stringify(orphan.body));
  });
  const oneOnt = await request('POST', '/api/projects/' + id + '/budget', { ontId: firstOnt });
  const everyOnt = await request('POST', '/api/projects/' + id + '/budget', {});
  const noAcometida = await request('POST', '/api/projects/' + id + '/budget', { ontId: orphanId });
  test('a single-ONT budget is one row of the shape the list returns', function () {
    assert.strictEqual(oneOnt.status, 200, JSON.stringify(oneOnt.body));
    assert.strictEqual(oneOnt.body.budgets.length, 1);
    const row = oneOnt.body.budgets[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ['name', 'ont', 'result']);
    assert.strictEqual(row.ont, firstOnt, 'ont is the node id, not the ONT model');
    const fromList = everyOnt.body.budgets.filter(function (b) { return b.ont === firstOnt; })[0];
    assert.strictEqual(row.name, fromList.name);
    assert.ok(!row.result.ont || row.result.ont !== row.ont, 'the model lives in result.ont, the row names the node');
    assert.strictEqual(row.result.verdict, fromList.result.verdict);
    assert.strictEqual(row.result.headroomDb, fromList.result.headroomDb);
  });
  test('a disconnected ONT is the same 200 error row from either call, never a 500', function () {
    assert.strictEqual(noAcometida.status, 200, JSON.stringify(noAcometida.body));
    const row = noAcometida.body.budgets[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ['error', 'name', 'ont']);
    assert.strictEqual(row.ont, orphanId);
    assert.ok(/not connected/.test(row.error), row.error);
    const fromList = everyOnt.body.budgets.filter(function (b) { return b.ont === orphanId; })[0];
    assert.deepStrictEqual(row, fromList);
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
