'use strict';
// The plant-level band note promised a pad that does not clear the OLT receiver.
//
// A pad is ODN loss, so one pad in the ODN serves both receivers of a PON - and the note has to name
// the largest either direction needs (#233). It did that for two *bands*, but `bandSummary` reads
// only `launchWindowPad`. A receiver that is already over its overload point at the **floor** launch
// is reported through `attenuator` instead (the two are mutually exclusive), and its pad was
// invisible to the note. So on a plant in the band downstream and hard over upstream the page
// printed two pad sizes: the failure line's "fit a 6 dB inline pad" and the band note's "4 dB of
// inline pad at the OLT carries the design to full launch" - false twice over, because 4 dB leaves
// the OLT 2 dB above its overload point at the top of the ONT's launch window.
//
// The plant, all from `opticalBudget`: gpon-c-plus-8, a 1:8 PLC 200 m out, a 30 m drop, 1 splice,
// 2 connectors.
//
//   downstream  0.044 + 0.007 fibre + 10.50 splitter + 0.10 splice + 0.60 connectors = 11.251 dB
//               +3 - 11.251 = -8.25 dBm on a -8 dBm ONT overload: inside at the floor, `ok`.
//               +7 - 11.251 = -4.25 dBm, 3.75 dB over at the top, so ceil(3.75) = 4 dB of pad.
//   upstream    0.35 dB/km: 0.070 + 0.011 + 10.50 + 0.10 + 0.60 = 11.281 dB
//               +0.5 - 11.281 = -10.78 dBm on a -12 dBm OLT overload: 1.22 dB over at the *floor*
//               launch, so `fail`, and the pad is ceil(5 - 11.281 + 12) = ceil(5.72) = 6 dB.
//
// The pad the plant takes is the one that clears each receiver at the top of its window: 6 dB leaves
// the OLT at 5 - 11.281 - 6 = -12.28 dBm. The note must name one pad, and it must be 6 dB.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const registry = engine.createRegistry();

function design(direction) {
  return {
    direction: direction,
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ lengthM: 200, cable: 'g652d-loose-12' }, { lengthM: 30, cable: 'g657a2-drop-2' }],
    splitters: [{ model: 'plc-1x8-sca' }],
    splices: 1,
    connectors: 2
  };
}

const down = engine.budget.opticalBudget(design('down'), registry);
const up = engine.budget.opticalBudget(design('up'), registry);
const downRow = { ont: 'n3', name: 'House 1', result: down };
const upRow = { ont: 'n3', name: 'House 1', result: up };

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-band-hard-'));
const server = createServer({ dataRoot: dataRoot });
function request(method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function op(body, id) { return request('POST', '/api/projects/' + id + '/ops', body); }

async function seedPlant() {
  const created = await request('POST', '/api/projects', { name: 'Band then hard over' });
  const id = JSON.parse(created.text).id;
  await op({ op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } }, id);
  await op({ op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca' } }, id);
  await op({ op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge' } }, id);
  await op({ op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 200, splices: 1 } }, id);
  await op({ op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-2', lengthM: 30 } }, id);
  return id;
}

async function main() {
  test('the premise: downstream in the band, upstream over its overload point at the floor launch', function () {
    assert.strictEqual(down.verdict, 'ok', JSON.stringify(down.reasons));
    assert.strictEqual(down.odnLossDb, 11.251, '0.051 fibre + 10.50 splitter + 0.10 splice + 0.60 connectors');
    assert.strictEqual(down.launchWindowPad.padDb, 4, 'ceil(3.75) = 4 dB at the OLT ceiling');
    assert.strictEqual(down.attenuator, null, 'the ONT is inside its overload point at the floor launch');
    assert.strictEqual(up.verdict, 'fail', JSON.stringify(up.reasons));
    assert.strictEqual(up.odnLossDb, 11.281, '1310 nm: 0.081 fibre + 10.50 + 0.10 + 0.60');
    assert.strictEqual(up.attenuator.padDb, 6, 'ceil(5 - 11.281 + 12) = 6 dB at the ONT ceiling');
    assert.strictEqual(up.launchWindowPad, null, 'the floor launch is already too loud: attenuator owns it');
  });

  test('the band note names the pad that clears both receivers, not its own smaller one', function () {
    const note = engine.budget.launchWindowNote([downRow], { other: [upRow] });
    assert.ok(note, 'a plant in the band produced no note');
    assert.strictEqual(note.padDb, 6, 'the pad this ODN takes is the upstream 6 dB: ' + note.text);
    assert.strictEqual(note.padBinds, 'up', 'and the note says which direction set the size: ' + note.text);
    assert.ok(note.text.indexOf('4 dB of inline pad at the OLT carries the design') === -1,
      'the note still promises the downstream pad carries the design: ' + note.text);
    assert.ok(note.text.indexOf('6 dB') !== -1, 'the size a crew buys is missing: ' + note.text);
    assert.ok(note.text.indexOf('the upstream direction is already over') !== -1,
      'the reason the larger pad is needed is missing: ' + note.text);
    assert.ok(note.text.indexOf('the OLT receiver') !== -1,
      'the receiver the larger pad clears is missing: ' + note.text);
  });

  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const id = await seedPlant();
  const printed = await request('GET', '/print/project/' + id);

  test('the printed plan names one pad to buy, and it is the larger one', function () {
    assert.strictEqual(printed.status, 200);
    assert.ok(printed.text.indexOf('4 dB of inline pad at the OLT carries the design') === -1,
      'the page still tells a crew to fit 4 dB when the OLT receiver needs 6 dB');
    assert.ok(printed.text.indexOf('6 dB') !== -1, 'the 6 dB pad the OLT receiver needs is not on the page');
  });

  await new Promise(function (resolve) { server.close(resolve); });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  done();
}

main().catch(function (err) {
  console.error('FAIL suite crashed: ' + (err && err.stack ? err.stack : err));
  require('./harness').state.failed++;
});
