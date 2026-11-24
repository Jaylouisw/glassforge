'use strict';
// The printed plan budgets downstream only, so an upstream failure is signed off as clean.
//
// A PON is two links over one ODN: the OLT launches into the ONT (1490 nm, the OLT's window against
// the ONT's receiver) and the ONT launches into the OLT (1310 nm, the ONT's window against the OLT's
// receiver). `budget.opticalBudget` answers both - `direction: 'up'` reads the OLT receiver - but the
// plan page, the Signal tab and the auto-design report all budget the default direction. The page a
// crew signs off therefore carries the downstream verdict and nothing else, and the two disagree
// exactly where it costs money.
//
// Numbers, on this project (1:8 PLC, 1.2 km of g652d-loose-12 feeder, 300 m g657a2-drop-2 drop, the
// splitter's own splice and the two connectors `designForOnt` counts):
//
//   downstream  0.22 dB/km: 1.2 x 0.22 + 0.3 x 0.22 = 0.33 fibre + 10.50 splitter + 0.60 connectors
//               + 0.10 splice = 11.53 dB.  +3 dBm - 11.53 = -8.53 dBm on an ONT overload of -8 dBm:
//               inside it, so `ok` - and 3.47 dB over it at +7 dBm, which is the launch-window band
//               (#111) and a 4 dB pad, a warning rather than a failure.
//   upstream    0.35 dB/km at 1310: 1.2 x 0.35 + 0.3 x 0.35 = 0.525 fibre + 10.50 + 0.60 + 0.10 =
//               11.725 dB.  +0.5 dBm (the ONT's floor) - 11.725 = -11.22 dBm on an OLT overload of
//               -12 dBm - 0.78 dB ABOVE it. That is `fail`, and the pad is sized at the top of the
//               ONT's window (+5 dBm -> -6.72 dBm, 5.28 dB over) so a 6 dB pad is the one to buy.
//
// A crew reading the page fits the 4 dB pad the downstream band asks for and the OLT still saturates
// on the ONT's launch. The plan has to say the upstream direction fails.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-upstream-'));
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

/** A 1:8 estate whose downstream is clean and whose upstream is over the OLT's overload point. */
async function seedPlant(name) {
  const created = await request('POST', '/api/projects', { name: name });
  const id = created.body.id;
  async function op(step) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
    return answer.body;
  }
  const added = await op({ op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } });
  await op({ op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter', lat: 51.5, lon: -0.1 } });
  await op({ op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 1', lat: 51.502, lon: -0.0995 } });
  const nodes = added.nodes.map(function (n) { return n.id; });
  await op({ op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1200 } });
  await op({ op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-2', lengthM: 300 } });
  return id;
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const id = await seedPlant('Upstream over the OLT');
  const down = await request('POST', '/api/projects/' + id + '/budget', {});
  const up = await request('POST', '/api/projects/' + id + '/budget', { direction: 'up' });
  const printed = await request('GET', '/print/project/' + id);

  test('the engine already answers the upstream direction, and it fails where downstream passes', function () {
    const d = down.body.budgets[0].result;
    const u = up.body.budgets[0].result;
    assert.strictEqual(d.verdict, 'ok', 'the downstream half of this design is clean: ' + JSON.stringify(d.reasons));
    assert.strictEqual(d.odnLossDb, 11.53, '0.33 fibre + 10.50 splitter + 0.60 connectors + 0.10 splice');
    assert.strictEqual(u.verdict, 'fail', 'an OLT receiving -11.22 dBm against a -12 dBm overload point cannot be ok');
    assert.strictEqual(u.odnLossDb, 11.725, '0.525 fibre at 1310 nm + 10.50 + 0.60 + 0.10');
    assert.ok(u.reasons.join(' ').indexOf('above its overload point -12 dBm') !== -1, JSON.stringify(u.reasons));
  });

  test('the plan a crew signs off carries the upstream verdict, not just the downstream one', function () {
    assert.strictEqual(printed.status, 200);
    assert.ok(printed.text.indexOf('No errors and no warnings') === -1,
      'the plan prints as clean while the upstream direction is over the OLT receiver');
    assert.ok(printed.text.indexOf('fails upstream at the OLT receiver') !== -1,
      'the plan names no upstream verdict at all');
    assert.ok(printed.text.indexOf('Casa 1') !== -1, 'the upstream line does not say which ONT');
    assert.ok(printed.text.indexOf('6 dB inline pad') !== -1,
      'the pad the upstream direction needs (6 dB, sized at the top of the ONT window) is not on the page');
  });

  test('the downstream band note is still printed beside it', function () {
    assert.ok(printed.text.indexOf('launch window') !== -1,
      'the upstream addition replaced the downstream band note');
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
