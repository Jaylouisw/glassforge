'use strict';
// A saved plant has to be one the engine can budget. `PUT` always refused an invalid plant; `/ops`
// used to check it, put the errors in `derived.errors`, and save anyway with a 200 — so a span with
// a cable model that does not exist, or a PON cascaded past its OLT's split limit, landed on disk
// and only failed days later on site. These are the requests that used to succeed, and the stored
// state that proves they now do not.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { test, assert, done } = require('./harness');

const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-ops-'));
const server = createServer({ dataRoot: dataRoot });
let base = null;

function request(method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(base + pathname, {
      method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (err) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function op(projectId, operation) {
  return request('POST', '/api/projects/' + projectId + '/ops', operation);
}

// A whole project in an assertion message buries the line that failed. The status and the server's
// own sentence are what someone debugging this needs.
function brief(res) {
  const why = res.body && res.body.error ? res.body.error : JSON.stringify(res.body).slice(0, 200);
  return 'status ' + res.status + ': ' + why;
}

async function build(projectId, steps) {
  let last = null;
  for (const step of steps) last = await op(projectId, step);
  return last;
}

const validPlant = [
  { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
  { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'S1' } },
  { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa' } },
  { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 800, splices: 1, closures: 1 } },
  { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 45 } }
];

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  // ------------------------------------------------------------------ a good plant to break
  const created = await request('POST', '/api/projects', { name: 'Ops validation' });
  const id = created.body.id;

  const good = await build(id, validPlant);
  test('a valid edit is a 200 that carries no errors', function () {
    assert.strictEqual(created.status, 201);
    assert.strictEqual(good.status, 200, brief(good));
    assert.strictEqual(good.body.nodes.length, 3);
    assert.strictEqual(good.body.spans.length, 2);
    assert.deepStrictEqual(good.body.derived.errors, []);
  });

  const beforeBadOp = await request('GET', '/api/projects/' + id);
  const spansBefore = beforeBadOp.body.spans.length;
  const updatedAtBefore = beforeBadOp.body.updatedAt;

  // ------------------------------------------------------------------ unknown cable model
  // The op the audit found: `apply` copies the cable string through without checking the catalogue.
  const badCableOp = await op(id, {
    op: 'add-span',
    span: { from: 'n3', to: 'n2', cable: 'g652d-loose-999', lengthM: 10 }
  });
  test('an edit naming an unknown cable model is refused with a 400 naming the span and the cable', function () {
    assert.strictEqual(badCableOp.status, 400, brief(badCableOp));
    assert.strictEqual(typeof badCableOp.body.error, 'string');
    assert.ok(badCableOp.body.error.indexOf('unknown cable model') !== -1, badCableOp.body.error);
    assert.ok(badCableOp.body.error.indexOf('g652d-loose-999') !== -1, badCableOp.body.error);
    assert.ok(badCableOp.body.error.indexOf('"s3"') !== -1, 'the message should name the offending span: ' + badCableOp.body.error);
    assert.deepStrictEqual(badCableOp.body.errors, ['span "s3" uses unknown cable model "g652d-loose-999"']);
  });

  test('a refused edit answers with diagnostics, not with a project that looks saved', function () {
    assert.strictEqual(badCableOp.body.nodes, undefined, 'a 400 must not hand back a project the caller can mistake for persisted');
    assert.strictEqual(badCableOp.body.spans, undefined);
    assert.ok(Array.isArray(badCableOp.body.warnings));
  });

  const afterBadCable = await request('GET', '/api/projects/' + id);
  test('the refused edit left the stored plant untouched', function () {
    assert.strictEqual(afterBadCable.status, 200);
    assert.strictEqual(afterBadCable.body.spans.length, spansBefore, 'a refused op added a span to the stored plant');
    assert.strictEqual(afterBadCable.body.updatedAt, updatedAtBefore, 'a refused op still stamped updatedAt');
    const bad = afterBadCable.body.spans.filter(function (s) { return s.cable === 'g652d-loose-999'; });
    assert.strictEqual(bad.length, 0, 'the unknown cable model was persisted anyway');
    assert.deepStrictEqual(afterBadCable.body.derived.errors, [], 'the stored plant should still be the valid one');
  });

  // ------------------------------------------------------------------ PUT says the same thing
  const putSamePlant = await request('PUT', '/api/projects/' + id, {
    nodes: beforeBadOp.body.nodes,
    spans: beforeBadOp.body.spans.concat([{
      id: 's3', from: 'n3', to: 'n2', cable: 'g652d-loose-999', lengthM: 10, strands: [], splices: 0, closures: 0, route: null
    }])
  });
  test('PUT refuses the same plant, so ops and PUT now agree on what may be saved', function () {
    assert.strictEqual(putSamePlant.status, 400, brief(putSamePlant));
    assert.strictEqual(putSamePlant.body.error, 'the design does not validate');
    assert.deepStrictEqual(putSamePlant.body.errors, ['span "s3" uses unknown cable model "g652d-loose-999"']);
  });

  // ------------------------------------------------------------------ a valid op still lands
  const goodAfterBad = await op(id, {
    op: 'add-span',
    span: { from: 'n3', to: 'n2', cable: 'g657a2-drop-2', lengthM: 12 }
  });
  test('a valid op still succeeds and is persisted once the bad one is gone', function () {
    assert.strictEqual(goodAfterBad.status, 200, brief(goodAfterBad));
    assert.strictEqual(goodAfterBad.body.spans.length, spansBefore + 1);
    assert.deepStrictEqual(goodAfterBad.body.derived.errors, []);
    assert.strictEqual(goodAfterBad.body.spans[goodAfterBad.body.spans.length - 1].cable, 'g657a2-drop-2');
  });

  const afterGoodOp = await request('GET', '/api/projects/' + id);
  test('the accepted edit survives a re-read from disk', function () {
    assert.strictEqual(afterGoodOp.body.spans.length, spansBefore + 1);
    const drop2 = afterGoodOp.body.spans.filter(function (s) { return s.cable === 'g657a2-drop-2'; });
    assert.strictEqual(drop2.length, 1);
    assert.strictEqual(drop2[0].lengthM, 12);
    assert.deepStrictEqual(afterGoodOp.body.derived.errors, []);
  });

  // ------------------------------------------------------------------ over split limit
  // A separate project: `validate` only reaches the capacity check once the structural ones are
  // clean, so a plant already carrying a bad span would prove nothing about the split limit.
  const overId = (await request('POST', '/api/projects', { name: 'Over-split' })).body.id;
  const preCascade = await build(overId, [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'S1' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x16-sca', name: 'S2' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 500 } }
  ]);
  test('an unconnected splitter is still a legal design in progress', function () {
    assert.strictEqual(preCascade.status, 200, brief(preCascade));
    assert.deepStrictEqual(preCascade.body.derived.errors, []);
  });

  // 1:8 behind a 1:64 OLT is fine; adding the 1:16 makes the deepest path 1:128.
  const overSplit = await op(overId, { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g652d-loose-24', lengthM: 40 } });
  test('an edit that pushes the PON past its split limit is refused with a 400 naming the limit', function () {
    assert.strictEqual(overSplit.status, 400, brief(overSplit));
    assert.ok(overSplit.body.error.indexOf('splitter cascade') !== -1, overSplit.body.error);
    assert.ok(overSplit.body.error.indexOf('1:128') !== -1, overSplit.body.error);
    assert.ok(overSplit.body.error.indexOf('1:64') !== -1, overSplit.body.error);
    assert.strictEqual(overSplit.body.errors.length, 1);
    assert.ok(/beyond the gpon-b-plus-8 limit of 1:64/.test(overSplit.body.errors[0]), overSplit.body.errors[0]);
  });

  const afterOverSplit = await request('GET', '/api/projects/' + overId);
  test('the over-split plant was not saved: the second cable is not on disk', function () {
    assert.strictEqual(afterOverSplit.body.spans.length, 1, 'the over-split span was persisted');
    const toS2 = afterOverSplit.body.spans.filter(function (s) { return s.to === 'n3' || s.from === 'n3'; });
    assert.strictEqual(toS2.length, 0);
    assert.deepStrictEqual(afterOverSplit.body.derived.errors, [], 'the stored plant should still be the valid one');
    // The node itself was accepted by its own, valid, op - refusing the cable must not roll that back.
    assert.strictEqual(afterOverSplit.body.nodes.length, 4);
  });

  const overSplitAgain = await op(overId, { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g652d-loose-24', lengthM: 40 } });
  const afterOverSplitAgain = await request('GET', '/api/projects/' + overId);
  test('repeating the refused edit is refused again, and still writes nothing', function () {
    assert.strictEqual(overSplitAgain.status, 400);
    assert.strictEqual(overSplitAgain.body.errors.length, 1);
    assert.strictEqual(afterOverSplitAgain.body.spans.length, 1);
    assert.strictEqual(afterOverSplitAgain.body.updatedAt, afterOverSplit.body.updatedAt);
  });

  // --------------------------------------------------- ports are fibres, not cables
  // The shape auto-design emits: eight customers sharing one distribution cable, one strand each. The
  // site is full (8 of 8 ports), and a ninth customer on that same cable has no port to land on. While
  // ports were counted as cabled outputs this plant read "1 of 8" and the ninth drop was saved with a
  // 200 - a fibre somebody would have to buy, dress and then discover was not lit.
  const sharedId = (await request('POST', '/api/projects', { name: 'Shared cable' })).body.id;
  const sharedSteps = [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'S1' } },
    { op: 'add-node', node: { type: 'closure', model: 'nap-16', name: 'NAP' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 800 } },
    { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 60, strands: [1, 2, 3, 4, 5, 6, 7, 8] } }
  ];
  for (let i = 1; i <= 8; i++) {
    sharedSteps.push({ op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i } });
    sharedSteps.push({ op: 'add-span', span: { from: 'n3', to: 'n' + (3 + i), cable: 'g657a2-drop-1', lengthM: 40, strands: [i] } });
  }
  const eightOnOneCable = await build(sharedId, sharedSteps);
  test('eight customers down one cable fill a 1:8, and the plant reports eight ports used', function () {
    assert.strictEqual(eightOnOneCable.status, 200, brief(eightOnOneCable));
    assert.deepStrictEqual(eightOnOneCable.body.derived.errors, []);
    const site = eightOnOneCable.body.derived.summary.capacity.splitterPorts[0];
    assert.strictEqual(site.portsUsed, 8, 'one cable, eight customer fibres, eight ports');
    assert.strictEqual(site.overbooked, false);
  });

  const ninthOnCable = await build(sharedId, [
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 9' } },
    { op: 'add-span', span: { from: 'n3', to: 'n12', cable: 'g657a2-drop-1', lengthM: 40, strands: [9] } }
  ]);
  test('a ninth customer on that cable is a 400 naming the site, not a saved fibre', function () {
    assert.strictEqual(ninthOnCable.status, 400, brief(ninthOnCable));
    assert.strictEqual(ninthOnCable.body.errors.length, 1, ninthOnCable.body.errors.join(' | '));
    assert.strictEqual(ninthOnCable.body.errors[0],
      'splitter "S1" (n2) has 9 fibres leaving it on 8 output ports (plc-1x8-sca) - 1 fibre has no port');
  });

  const afterNinth = await request('GET', '/api/projects/' + sharedId);
  test('the refused ninth drop is not on disk, and the eight are untouched', function () {
    assert.strictEqual(afterNinth.body.spans.length, 10, 'the ninth drop was persisted');
    assert.strictEqual(afterNinth.body.nodes.filter(function (n) { return n.type === 'ont'; }).length, 9,
      'the node op itself was valid and stays');
    assert.deepStrictEqual(afterNinth.body.derived.errors, [], 'the stored plant is still the buildable one');
  });

  // ------------------------------------------------------------------ warnings are not errors
  const warnId = (await request('POST', '/api/projects', { name: 'Warnings' })).body.id;
  await build(warnId, [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'closure', model: 'nap-8', name: 'NAP' } }
  ]);
  const longSpan = await op(warnId, { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-48', lengthM: 25000 } });
  test('a warning is still a 200: a 25 km span is a question, not a contradiction', function () {
    assert.strictEqual(longSpan.status, 200, brief(longSpan));
    assert.deepStrictEqual(longSpan.body.derived.errors, []);
    assert.ok(longSpan.body.warnings.some(function (w) { return w.indexOf('over 20 km') !== -1; }),
      JSON.stringify(longSpan.body.warnings));
  });

  const warnStored = await request('GET', '/api/projects/' + warnId);
  test('the warned-about span is persisted, so the warning stays attached to a real plant', function () {
    assert.strictEqual(warnStored.body.spans.length, 1);
    assert.strictEqual(warnStored.body.spans[0].lengthM, 25000);
  });

  // ------------------------------------------------------------------ a bad field the engine names
  const badModel = await op(id, { op: 'update-node', id: 'n2', patch: { model: 'plc-1x99-sca' } });
  test('an edit giving a node a model the catalogue does not have is refused, naming the node', function () {
    assert.strictEqual(badModel.status, 400, brief(badModel));
    assert.ok(badModel.body.error.indexOf('"n2"') !== -1, badModel.body.error);
    assert.ok(badModel.body.error.indexOf('unknown splitter model') !== -1, badModel.body.error);
    assert.deepStrictEqual(badModel.body.errors, ['node "n2" uses unknown splitter model "plc-1x99-sca"']);
  });


  // ------------------------------------------------------------------ a node's type is not an edit field
  // `update-node` copied `type` out of the patch and the op's contract is name/model/lat/lon. The
  // field is not cosmetic: `computeOdn` charges a splitter's loss only on a node of type splitter,
  // so retyping this plant's 1:8 to a closure kept its model as a warning and dropped 10.5 dB out of
  // the ODN with a 200 - a healthy estate answering "fail - too loud, fit a pad". Retyping the only
  // ONT has the other shape: the customer leaves /budget and the BOM with no error at all.
  const retyped = await op(id, { op: 'update-node', id: 'n2', patch: { type: 'closure' } });
  test('retyping a node through update-node is a 400 naming the node and the field', function () {
    assert.strictEqual(retyped.status, 400, brief(retyped));
    assert.ok(retyped.body.error.indexOf('"n2"') !== -1, retyped.body.error);
    assert.ok(retyped.body.error.indexOf('type') !== -1, retyped.body.error);
  });

  const afterRetype = await request('GET', '/api/projects/' + id);
  const afterRetypeBudget = await request('POST', '/api/projects/' + id + '/budget', {});
  test('the refused retype left the splitter a splitter, so its 10.5 dB is still in the budget', function () {
    const splitter = afterRetype.body.nodes.filter(function (n) { return n.id === 'n2'; })[0];
    assert.strictEqual(splitter.type, 'splitter', 'the 200 that retyped the plant is back');
    assert.deepStrictEqual(afterRetype.body.derived.errors, []);
    const row = afterRetypeBudget.body.budgets[0].result;
    const split = row.breakdown.filter(function (b) { return b.kind === 'splitter'; })[0];
    assert.ok(split, 'the splitter loss is not in the ODN: ' + JSON.stringify(row.breakdown));
    assert.strictEqual(split.db, 10.5);
    assert.strictEqual(row.verdict, 'ok');
  });

  const wrongOntKind = await op(id, { op: 'update-node', id: 'n3', patch: { model: 'sfp-plus-10g-er-40km' } });
  test('an ONT given a transceiver model is refused for the same reason, with the engine\'s wording', function () {
    assert.strictEqual(wrongOntKind.status, 400, brief(wrongOntKind));
    assert.ok(wrongOntKind.body.error.indexOf('transceiver') !== -1, wrongOntKind.body.error);
    assert.strictEqual(wrongOntKind.body.errors.length, 1);
  });

  const finalGet = await request('GET', '/api/projects/' + id);
  test('none of the refusals in this suite left a mark on the project', function () {
    const node = finalGet.body.nodes.filter(function (n) { return n.id === 'n3'; })[0];
    const splitter = finalGet.body.nodes.filter(function (n) { return n.id === 'n2'; })[0];
    assert.strictEqual(node.model, 'gpon-ont-4ge');
    assert.strictEqual(splitter.model, 'plc-1x8-sca');
    assert.deepStrictEqual(finalGet.body.derived.errors, []);
  });

  // ------------------------------------------------------------------ a splice count that is not a count
  // `cableToBuy` refuses text ("splices must be a number or an array"), so a span saved with
  // splices: 'two' made every /bom call for its project a 500 - the server blamed for the caller's
  // own typo at save time. The write gate now refuses the field, the stored plant still prices, and
  // a file edited by hand is named by the validator and by /bom.
  const countId = (await request('POST', '/api/projects', { name: 'Bad counts' })).body.id;
  await build(countId, validPlant);

  const textSplices = await op(countId, {
    op: 'add-span', span: { from: 'n3', to: 'n2', cable: 'g657a2-drop-1', lengthM: 10, splices: 'two' }
  });
  test('an edit whose splice count is text is refused with a 400 naming the field and the value', function () {
    assert.strictEqual(textSplices.status, 400, brief(textSplices));
    assert.ok(textSplices.body.error.indexOf('span.splices') !== -1, textSplices.body.error);
    assert.ok(textSplices.body.error.indexOf('"two"') !== -1, textSplices.body.error);
  });

  const afterTextSplices = await request('GET', '/api/projects/' + countId);
  const bomAfterText = await request('GET', '/api/projects/' + countId + '/bom');
  test('the refused count was not saved, and the BOM for the stored plant still prices', function () {
    assert.strictEqual(afterTextSplices.body.spans.length, 2, 'the text count was persisted');
    assert.strictEqual(bomAfterText.status, 200, brief(bomAfterText));
    assert.strictEqual(bomAfterText.body.spanCount, 2);
  });

  const negativeClosures = await op(countId, {
    op: 'add-span', span: { from: 'n3', to: 'n2', cable: 'g657a2-drop-1', lengthM: 10, closures: -2 }
  });
  const fractionalSplices = await op(countId, {
    op: 'add-span', span: { from: 'n3', to: 'n2', cable: 'g657a2-drop-1', lengthM: 10, splices: 1.5 }
  });
  test('a negative or fractional count is refused too - a count is a whole number', function () {
    assert.strictEqual(negativeClosures.status, 400, brief(negativeClosures));
    assert.ok(negativeClosures.body.error.indexOf('span.closures') !== -1, negativeClosures.body.error);
    assert.strictEqual(fractionalSplices.status, 400, brief(fractionalSplices));
    assert.ok(fractionalSplices.body.error.indexOf('span.splices') !== -1, fractionalSplices.body.error);
  });

  const storedForPut = await request('GET', '/api/projects/' + countId);
  const putBadCount = await request('PUT', '/api/projects/' + countId, {
    nodes: storedForPut.body.nodes,
    spans: storedForPut.body.spans.concat([{
      id: 's9', from: 'n3', to: 'n2', cable: 'g657a2-drop-1', lengthM: 10, splices: 'two', closures: 0
    }])
  });
  test('PUT refuses the same field, because a PUT body never passes through apply()', function () {
    assert.strictEqual(putBadCount.status, 400, brief(putBadCount));
    assert.deepStrictEqual(putBadCount.body.errors, ['span "s9" has an invalid splices count "two"']);
  });

  // A file edited by hand never met the write gate. It is still this API's job to say which span is
  // wrong rather than to throw cableToBuy's sentence through the 500 path.
  const handPath = path.join(dataRoot, 'projects', countId + '.json');
  const hand = JSON.parse(fs.readFileSync(handPath, 'utf8'));
  hand.spans[0].splices = 'two';
  fs.writeFileSync(handPath, JSON.stringify(hand));
  const handRead = await request('GET', '/api/projects/' + countId);
  test('a hand-edited project is named by the validator instead of validating clean', function () {
    assert.deepStrictEqual(handRead.body.derived.errors, ['span "s1" has an invalid splices count "two"']);
  });
  const handBom = await request('GET', '/api/projects/' + countId + '/bom');
  test('the BOM for that file is a 400 naming the span, not a 500 blaming the server', function () {
    assert.strictEqual(handBom.status, 400, brief(handBom));
    assert.ok(handBom.body.error.indexOf('span "s1" has an invalid splices count "two"') !== -1, handBom.body.error);
  });

  // ------------------------------------------------------------------ a bundle count that is not a count
  // `bundles` is how many cables run a span - auto-design sets 2 when the fibres do not fit one cable.
  // Reading it is only safe with a gate: `bundles: 0` in a hand-edited file would buy no cable for a
  // span that is drawn on the map, so the write gate refuses it and /bom names the span rather than
  // letting the purchase arithmetic throw through the 500 path.
  const bundleId = (await request('POST', '/api/projects', { name: 'Bundle counts' })).body.id;
  await build(bundleId, validPlant);
  const storedBundle = await request('GET', '/api/projects/' + bundleId);
  const putBadBundle = await request('PUT', '/api/projects/' + bundleId, {
    nodes: storedBundle.body.nodes,
    spans: storedBundle.body.spans.map(function (span, i) {
      return i === 0 ? Object.assign({}, span, { bundles: 0 }) : span;
    })
  });
  test('PUT refuses a bundles count of zero, naming the span and the field', function () {
    assert.strictEqual(putBadBundle.status, 400, brief(putBadBundle));
    assert.deepStrictEqual(putBadBundle.body.errors, ['span "s1" has an invalid bundles count "0"']);
  });

  const bundlePath = path.join(dataRoot, 'projects', bundleId + '.json');
  const bundleFile = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  bundleFile.spans[0].bundles = 1.5;
  fs.writeFileSync(bundlePath, JSON.stringify(bundleFile));
  const bundleRead = await request('GET', '/api/projects/' + bundleId);
  const bundleBom = await request('GET', '/api/projects/' + bundleId + '/bom');
  test('a hand-edited bundles count is named by the validator and by the BOM, not blamed on the server', function () {
    assert.deepStrictEqual(bundleRead.body.derived.errors, ['span "s1" has an invalid bundles count "1.5"']);
    assert.strictEqual(bundleBom.status, 400, brief(bundleBom));
    assert.ok(bundleBom.body.error.indexOf('span "s1" has an invalid bundles count "1.5"') !== -1, bundleBom.body.error);
  });

  // ------------------------------------------------------------------ a span with no measured length
  // `billOfMaterials` refuses a span whose length is missing, zero or not a number - "span s1 has no
  // measured length" - because a BOM is the number someone spends money against. The write gate
  // already refuses such an edit, but a file edited by hand never met the gate, and /bom used to let
  // the engine's sentence escape through the 500 path: "internal error", i.e. the server blamed for
  // the file's field. Same answer as the splices and bundles counts above - a 400 naming the span.
  const lengthId = (await request('POST', '/api/projects', { name: 'No length' })).body.id;
  await build(lengthId, validPlant);
  const lengthPath = path.join(dataRoot, 'projects', lengthId + '.json');
  const lengthFile = JSON.parse(fs.readFileSync(lengthPath, 'utf8'));
  lengthFile.spans[0].lengthM = 0;
  fs.writeFileSync(lengthPath, JSON.stringify(lengthFile));
  const zeroBom = await request('GET', '/api/projects/' + lengthId + '/bom');
  test('a span with no measured length makes the BOM a 400 naming the span, not a 500', function () {
    assert.strictEqual(zeroBom.status, 400, brief(zeroBom));
    assert.ok(zeroBom.body.error.indexOf('span "s1" has no measured length') !== -1, zeroBom.body.error);
  });

  delete lengthFile.spans[0].lengthM;
  fs.writeFileSync(lengthPath, JSON.stringify(lengthFile));
  const absentBom = await request('GET', '/api/projects/' + lengthId + '/bom');
  test('an absent length is the same refusal - absent is not zero, and neither is a purchase', function () {
    assert.strictEqual(absentBom.status, 400, brief(absentBom));
    assert.ok(absentBom.body.error.indexOf('span "s1" has no measured length') !== -1, absentBom.body.error);
  });

  // ------------------------------------------------------------------ a name that is not a string
  // `rename` ran `String(name).trim()`, so `{ name: {} }` renamed the project to "[object Object]"
  // - the exact sentence `#129` added the create/PUT refusal for, reached through the one write that
  // skipped it. `add-node` copied `name` through raw, so an object landed on disk and the canvas
  // label read "[object Object]". A name is a string, or absent, on both.
  const nameId = (await request('POST', '/api/projects', { name: 'Names' })).body.id;
  await build(nameId, validPlant);
  const badRenameOp = await op(nameId, { op: 'rename', name: { a: 1 } });
  test('renaming a project to an object is a 400 naming the field, not "[object Object]"', function () {
    assert.strictEqual(badRenameOp.status, 400, brief(badRenameOp));
    assert.strictEqual(badRenameOp.body.error, 'the project name must be a string, got an object');
  });
  const afterBadRename = await request('GET', '/api/projects/' + nameId);
  test('the refused rename left the stored name alone', function () {
    assert.strictEqual(afterBadRename.body.name, 'Names');
  });

  const badNodeName = await op(nameId, { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 5 } });
  test('an added node whose name is not a string is refused, naming the node', function () {
    assert.strictEqual(badNodeName.status, 400, brief(badNodeName));
    assert.deepStrictEqual(badNodeName.body.errors, ['node "n4" name must be a string, got a number']);
  });
  const afterBadNode = await request('GET', '/api/projects/' + nameId);
  test('the refused node was not saved', function () {
    assert.deepStrictEqual(afterBadNode.body.nodes.map(function (n) { return n.id; }), ['n1', 'n2', 'n3']);
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
