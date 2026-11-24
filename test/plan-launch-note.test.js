'use strict';
// The launch-window band, said once for the plant (#111, #110).
//
// Every OLT in the catalogue has a 3-4 dB launch window, so an ordinary estate - a 1:16 splitter with
// short drops - sits in the band where the design is clean only while every line card lands at the
// bottom of that window. The engine learned to say so per ONT (#111) and to size the pad (#110); the
// auto-design report then said it once for the plant, because 300 copies of one sentence is not a
// report (test/design-launch-window.test.js). The printed plan - the page a crew signs off - kept
// only the per-ONT sentences, so the share of the estate in the band and the pad to buy were never
// stated anywhere on it.
//
// The per-ONT attribution is a guarantee, not noise: test/budget-warning-surface.test.js asserts a
// warning names the ONT it is about. So this adds the plant-level sentence BESIDE the per-ONT rows
// rather than replacing them - the summary carries the count and the pad size, the rows carry who.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-band-'));
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

/** One row in the shape allOntBudgets produces, enough for the note to read. */
function row(ont, name, overDb, atTxDbm) {
  return {
    ont: ont,
    name: name,
    result: {
      olt: 'gpon-c-plus-8',
      txDbm: 3,
      verdict: 'ok',
      launchWindowPad: { overDb: overDb, padDb: Math.ceil(overDb), maxPadDb: 15, atTxDbm: atTxDbm, fits: true }
    }
  };
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function seedPlant(feederM, name) {
  // A 1:16 PLC (13.80 dB) over feederM of G.652.D with a 40 m drop per ONT. At 100 m the ODN is
  // 14.53 dB: -11.53 dBm at the +3 dBm floor of a C+ OLT (inside the ONT's -8 dBm overload point) and
  // -7.53 dBm at +7 dBm, 0.47 dB over it - so a 1 dB pad. At 3 km the feeder adds 0.64 dB of fibre and
  // the band is behind us (ODN 15.17 dB), so that plant needs no pad and says nothing.
  const created = await request('POST', '/api/projects', { name: name });
  const id = created.body.id;
  // The project names nodes n1, n2, ... itself; a span has to point at the ids it actually handed out.
  async function op(step) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
    return answer.body;
  }
  await op({ op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } });
  const splitter = await op({ op: 'add-node', node: { type: 'splitter', model: 'plc-1x16-sca',
    name: 'Splitter', lat: 51.5, lon: -0.1 } });
  const oltId = splitter.nodes[0].id;
  const splitterId = splitter.nodes[1].id;
  await op({ op: 'add-span', span: { from: oltId, to: splitterId, cable: 'g652d-loose-24', lengthM: feederM } });
  for (let i = 1; i <= 16; i++) {
    const added = await op({ op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i,
      lat: 51.5 + i * 0.00002, lon: -0.1 } });
    const ontId = added.nodes[added.nodes.length - 1].id;
    await op({ op: 'add-span', span: { from: splitterId, to: ontId, cable: 'g657a2-drop-1', lengthM: 40 } });
  }
  return id;
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  test('the note is the engine\'s, built from the rows, and named for the plant', function () {
    assert.strictEqual(typeof engine.budget.launchWindowNote, 'function',
      'the plant-level band note has no single implementation, so every caller writes its own');
    const note = engine.budget.launchWindowNote([row('n3', 'A', 0.5, 7), row('n4', 'B', 0.5, 7)]);
    assert.ok(note && typeof note.text === 'string', 'a band with two ONTs in it produced no note');
    assert.ok(note.text.indexOf('2 of 2 ONTs') !== -1, note.text);
    assert.strictEqual(note.onts, 2, 'the note counts the rows it was given');
    assert.strictEqual(note.padDb, 1, 'ceil(0.5) = 1 dB of pad');
  });

  test('a whole estate in the band on one pad size needs one pad at the OLT', function () {
    const note = engine.budget.launchWindowNote([row('n3', 'A', 3.55, 7), row('n4', 'B', 3.2, 7)]);
    assert.ok(note.text.indexOf('4 dB of inline pad at the OLT') !== -1, note.text);
    assert.ok(note.text.indexOf('worst 3.55 dB over at the 7 dBm') !== -1, note.text);
    assert.ok(note.text.indexOf('at each') === -1, 'one pad size serves the estate, so there is no "each": ' + note.text);
  });

  test('a band that needs two pad sizes is per-ONT even when every ONT is in it', function () {
    // ceil(3.55) = 4 dB and ceil(1.2) = 2 dB: a single pad at the OLT is one size, so the 4 dB pad
    // would spend 2 dB of the milder ONT's margin to fix the hotter one.
    const note = engine.budget.launchWindowNote([row('n3', 'A', 3.55, 7), row('n4', 'B', 1.2, 7)]);
    assert.ok(note.text.indexOf('at each of the 2 affected ONTs') !== -1, note.text);
    assert.ok(note.text.indexOf('1 x 4 dB, 1 x 2 dB') !== -1, 'the sizes are the order: ' + note.text);
    assert.ok(note.text.indexOf('at the OLT') === -1, note.text);
  });

  test('a part of the estate in the band gets one pad per affected ONT, never one at the OLT', function () {
    // A pad at the OLT is shared by every ONT below it: sizing one for the two ONTs in the band would
    // spend 1 dB of the other ONTs' margin and buy nothing for them. The note has to say which.
    const rows = [row('n3', 'A', 1.4, 7), row('n4', 'B', 0.6, 7), row('n5', 'C', 0, 7)];
    rows[2].result.launchWindowPad = null;
    const note = engine.budget.launchWindowNote(rows);
    assert.ok(note.text.indexOf('2 of 3 ONTs') !== -1, note.text);
    assert.ok(note.text.indexOf('at each of the 2 affected ONTs') !== -1, note.text);
    assert.ok(note.text.indexOf('at the OLT') === -1, 'a pad at the OLT would push the third ONT under: ' + note.text);
    assert.ok(note.text.indexOf('other 1') !== -1, 'the note must own the ONTs it does not cover: ' + note.text);
  });

  test('ties break on the ONT id, so the sentence never depends on plant order', function () {
    const forward = engine.budget.launchWindowNote([row('n2', 'A', 1.1, 7), row('n9', 'B', 1.1, 7)]);
    const backward = engine.budget.launchWindowNote([row('n9', 'B', 1.1, 7), row('n2', 'A', 1.1, 7)]);
    assert.strictEqual(forward.worstOnt, backward.worstOnt, 'the worst ONT flips with the row order');
    assert.strictEqual(forward.worstOnt, 'n2', 'equal overshoot must pick the lower id');
  });

  test('a plant clear of the band has no note at all', function () {
    assert.strictEqual(engine.budget.launchWindowNote([]), null);
    const clear = [row('n3', 'A', 0, 7)];
    clear[0].result.launchWindowPad = null;
    assert.strictEqual(engine.budget.launchWindowNote(clear), null,
      'a 0 dB pad is a plate nobody orders, and "0 of 1 ONTs" is not a note');
  });

  const inBandId = await seedPlant(100, 'In the band');
  const inBand = await request('POST', '/api/projects/' + inBandId + '/budget', {});
  const printed = await request('GET', '/print/project/' + inBandId);

  test('an estate in the band prints the count and the pad once, and still names each ONT', function () {
    const rows = inBand.body.budgets;
    assert.strictEqual(rows.length, 16);
    rows.forEach(function (r) {
      assert.ok(r.result.launchWindowPad, r.name + ' lost the pad its own budget computed');
      assert.strictEqual(r.result.verdict, 'ok', r.name + ': the band must not fail a design alone');
    });
    assert.ok(printed.text.indexOf('16 of 16 ONTs') !== -1,
      'the plan a crew signs off never says how much of the estate is in the band');
    assert.strictEqual(occurrences(printed.text, '16 of 16 ONTs'), 1,
      'the plant-level note is repeated once per ONT');
    assert.ok(printed.text.indexOf('1 dB of inline pad at the OLT') !== -1,
      'the pad the engine sized is not on the page that orders it');
    assert.ok(printed.text.indexOf('Casa 1') !== -1,
      'the summary replaced the per-ONT attribution the plan used to carry');
  });

  const clearId = await seedPlant(3000, 'Clear of the band');
  const clearPrinted = await request('GET', '/print/project/' + clearId);

  test('a plant past the top of the band prints no band note', function () {
    assert.strictEqual(clearPrinted.status, 200);
    assert.strictEqual(occurrences(clearPrinted.text, 'ONTs are inside the overload point'), 0,
      'a plant at ODN 15.17 dB is past the band and must not be told to buy a pad');
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
