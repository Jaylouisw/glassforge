'use strict';
// The project budget reads the launch power, or it refuses one it cannot read.
//
// `POST /api/projects/:id/budget` hands its body to `designForOnt` as the budget's options, and
// `designForOnt` built the design without `txDbm` - so `{"txDbm":7}` budgeted at the transmitter's
// minimum launch and echoed `txDbm: 3`, a `200` whose answer contradicts the request. That is the
// #161 defect one endpoint over: the launch is the design field that decides whether the receiver is
// overloaded, and dropping it reports the one case that cannot hurt the receiver as the case.
//
// Measured on the blind-zone plant below (the #111 worked example: C+ into a 1:8 over 3 km of
// G.652.D, 4 splices, 2 closures, a 60 m drop, ODN 11.87 dB):
//   launch +3 dBm (the floor)  rx -8.87 dBm, inside the ONT's -8 dBm overload point -> `ok`
//   launch +7 dBm (the ceiling) rx -4.87 dBm, 3.13 dB over it -> `fail`, fit a 4 dB pad
// Asking for +7 and getting the +3 row is a sign-off on a link that overdrives its ONT.
//
// The budget follows the topology, not the span's own counts: fibre 0.660 + 0.013, one splice at the
// splitter's tail 0.10, 2 connectors 0.60 and the 1:8 splitter 10.50 = 11.873 dB. The ONT's receiver
// is -30 dBm sensitivity / -8 dBm overload, so the headroom at +7 dBm is -4.87 - (-30) = 25.13 dB.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-launch-'));
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

// ODN 11.87 dB: 1:8 splitter 10.50 (9.03 ideal + 1.47 excess), 3 km x 0.22 = 0.66 fibre,
// 4 splices = 0.40, 2 connectors = 0.30, 60 m drop = 0.01. -8.87 dBm at +3 dBm against a
// -8 dBm overload point; -4.87 dBm at +7 dBm, 3.13 dB above it.
async function buildBlindZonePlant() {
  const created = await request('POST', '/api/projects', { name: 'Launch power' });
  const id = created.body.id;
  const steps = [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 30' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 3000, splices: 4, closures: 2 } },
    { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 60 } }
  ];
  for (const step of steps) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
  }
  return id;
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const id = await buildBlindZonePlant();

  const floor = await request('POST', '/api/projects/' + id + '/budget', {});
  test('with no launch given the budget still uses the transmitter\'s minimum', function () {
    const r = floor.body.budgets[0].result;
    assert.strictEqual(floor.status, 200);
    assert.strictEqual(r.txDbm, 3, '+3 dBm is the gpon-c-plus-8 floor');
    assert.strictEqual(r.rxPowerDbm, -8.87, '3 - 11.87');
    assert.strictEqual(r.verdict, 'ok', 'inside the overload point at the floor launch');
  });

  const hot = await request('POST', '/api/projects/' + id + '/budget', { txDbm: 7 });
  test('a launch power the caller asks for is the launch the row is budgeted at', function () {
    const r = hot.body.budgets[0].result;
    assert.strictEqual(hot.status, 200);
    assert.strictEqual(r.txDbm, 7, 'the row must echo the launch it was computed at, not the floor');
    assert.strictEqual(r.rxPowerDbm, -4.87, '7 - 11.87');
    // -4.87 dBm into a -30 dBm receiver = 25.13 dB of headroom, at the launch that was asked for.
    assert.strictEqual(r.headroomDb, 25.13);
  });

  test('and the verdict follows that launch: +7 dBm overdrives the ONT and names the pad', function () {
    const r = hot.body.budgets[0].result;
    assert.strictEqual(r.verdict, 'fail', 'a link 3.13 dB over its overload point is not ok');
    assert.ok(r.attenuator, 'the pad a too-loud receiver needs is reported');
    assert.strictEqual(r.attenuator.padDb, 4, '3.13 dB of overload needs a 4 dB pad');
    assert.strictEqual(r.attenuator.atTxDbm, 7);
    assert.ok(r.reasons.some(function (x) { return x.indexOf('overload point') !== -1; }), r.reasons.join(' | '));
  });

  // A launch the budget cannot read is the request's mistake and fails every ONT the same way, so it
  // is one 400 naming the field - the same answer `marginDb: "3"` gets - and not a 200 whose row
  // quietly falls back to the floor, which is the drop this suite exists for.
  const text = await request('POST', '/api/projects/' + id + '/budget', { txDbm: '7' });
  test('a launch power that is not a number is a 400 naming the field', function () {
    assert.strictEqual(text.status, 400, text.text);
    assert.ok(text.body.error.indexOf('txDbm') !== -1, text.body.error);
  });

  server.close();
  done();
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
  done();
});
