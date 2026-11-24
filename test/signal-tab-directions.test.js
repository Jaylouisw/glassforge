'use strict';
// The Signal tab answered half of "is this plant audible" (#185).
//
// A PON is two links over one ODN: the OLT launches into the ONT at 1490 nm, and the ONT launches
// into the OLT at 1310 nm - the more lossy wavelength, into the receiver with the tighter overload.
// `POST /api/projects/:id/budget {"direction":"up"}` answered the real upstream verdict, and the
// printed plan had used it since #184, but the tab asked for the default direction only. So a crew
// read `ok` downstream, fitted the 4 dB pad the downstream warning names, and the OLT still
// saturated on the ONT's launch - the failure was in the pass nobody ran.
//
// This suite pins three things: the two numbers that disagree on one ODN, the join rule the tab uses
// to put them on one card (`web/signal.js`), and that the tab asks for both passes. The rendering
// itself is checked on the real page, as with every other UI guard here.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');
const signal = require('../web/signal');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-signal-'));
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

async function seed(name, steps) {
  const created = await request('POST', '/api/projects', { name: name });
  const id = created.body.id;
  for (const step of steps) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
  }
  return id;
}

// The #185 worked example, unchanged: C+ line card through a 1:8 splitter, 1.2 km of 12-fibre feeder
// and a 300 m drop. Downstream the ODN is 11.53 dB (feeder 1.2 km x 0.22 = 0.264, drop 0.3 x 0.22 =
// 0.066, splitter 10.50, two connectors 0.60, one spliced splitter tail 0.10), so the +3 dBm launch
// floor puts -8.53 dBm on an ONT whose overload is -8 dBm: inside it, `ok`, with the launch-window
// band warning. Upstream the same glass is 11.73 dB (0.42 + 0.105 at 0.35 dB/km, the rest equal), and
// the ONT's +0.5 dBm floor puts -11.22 dBm on an OLT receiver whose overload is -12 dBm: 0.78 dB over,
// `fail`, and the pad that clears it is 6 dB - not the 4 dB the downstream warning named.
function cplusEstate() {
  return [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 185' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1200 } },
    { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-2', lengthM: 300 } }
  ];
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const estateId = await seed('C+ estate', cplusEstate());
  const downPayload = await request('POST', '/api/projects/' + estateId + '/budget', {});
  const upPayload = await request('POST', '/api/projects/' + estateId + '/budget', { direction: 'up' });
  const downRow = downPayload.body.budgets[0];
  const upRow = upPayload.body.budgets[0];

  test('one ODN, two verdicts: ok downstream is not ok upstream', function () {
    assert.strictEqual(downRow.result.verdict, 'ok', 'the downstream pass is the one the tab used to show');
    assert.strictEqual(downRow.result.rxPowerDbm, -8.53, '3 dBm launch - 11.53 dB of ODN');
    assert.strictEqual(downRow.result.odnLossDb, 11.53);
    assert.strictEqual(upRow.result.verdict, 'fail', 'the upstream pass is the half nobody ran');
    assert.strictEqual(upRow.result.rxPowerDbm, -11.22, '0.5 dBm launch - 11.725 dB of 1310 nm ODN');
    assert.strictEqual(upRow.result.overloadDbm, -12);
    assert.strictEqual(upRow.result.reasons.length, 1, upRow.result.reasons.join(' | '));
    assert.ok(/6 dB inline pad/.test(upRow.result.reasons[0]), upRow.result.reasons[0]);
  });

  test('the two passes join onto one card per ONT, in the plant order', function () {
    const cards = signal.merge(downPayload.body.budgets, upPayload.body.budgets);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].ont, downRow.ont);
    assert.strictEqual(cards[0].name, 'Casa 185');
    assert.strictEqual(cards[0].error, null);
    assert.strictEqual(cards[0].down.verdict, 'ok');
    assert.strictEqual(cards[0].up.verdict, 'fail');
    assert.strictEqual(cards[0].upError, null);
    assert.strictEqual(cards[0].down.warnings.length, 1, 'the band warning is on the downstream block');
    assert.strictEqual(signal.title(cards[0].down), 'Downstream \u00b7 1490 nm');
    assert.strictEqual(signal.title(cards[0].up), 'Upstream \u00b7 1310 nm');
  });

  test('a path fault is said once, not once per direction', function () {
    const broken = [{ ont: 'n3', name: 'Casa 9', error: 'no route from the OLT to ont "n3"' }];
    const cards = signal.merge(broken, broken);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].error, 'no route from the OLT to ont "n3"');
    assert.strictEqual(cards[0].down, null, 'an unbudgetable path is not a downstream result');
    assert.strictEqual(cards[0].up, null);
    assert.strictEqual(cards[0].upError, null, 'the upstream pass reports the same path fault; one card says it once');
  });

  test('an upstream pass that did not run leaves the downstream cards standing', function () {
    const rows = [{ ont: 'n3', name: 'Casa 185', result: downRow.result }];
    const cards = signal.merge(rows, null);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].down.verdict, 'ok');
    assert.strictEqual(cards[0].up, null, 'no verdict is invented for a pass that did not answer');
    // An upstream row for an ONT the downstream pass does not know is not invented onto a card: the
    // cards are the ONTs the plant has, not the ones a second pass mentioned.
    const strangers = signal.merge([], [{ ont: 'ghost', name: 'Ghost', result: upRow.result }]);
    assert.strictEqual(strangers.length, 0);
  });

  // An active pair is budgeted by `pointToPoint`, which answers no `pon` and no `oltClass`: its
  // budget is the optic pair's, not an ODN class. The card was built for a PON, so it printed
  // "ODN loss 0.35 dB of 9.8 dB undefined undefined" on every head-end plant - and the second
  // direction would have printed it twice. Seeded here rather than inside a `test()`: the harness
  // counts a promise-returning test as passed the moment it returns.
  const activeId = await seed('Active pair', [
    { op: 'add-node', node: { type: 'headend', model: 'qsfp28-100g-lr4-10km', name: 'DC A' } },
    { op: 'add-node', node: { type: 'ont', model: 'qsfp28-100g-lr4-10km', name: 'DC B' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1000 } }
  ]);
  const activePayload = await request('POST', '/api/projects/' + activeId + '/budget', {});
  const active = activePayload.body.budgets[0].result;

  test('the class row is a PON row, so an active pair prints no undefined', function () {
    // 1 km of G.652.D at 1310 nm = 0.35 dB, two connectors 0.60 -> 0.95 dB of ODN against the pair's
    // 6.3 dB budget; the 100G-LR4 pair launches at its floor onto a -10.6 dBm sensitivity.
    assert.strictEqual(active.pon, undefined, 'an active pair has no PON class to name');
    const printed = signal.rows(active).map(function (row) { return row[0] + ': ' + row[1]; }).join(' | ');
    assert.strictEqual(printed.indexOf('undefined'), -1, printed);
    assert.ok(printed.indexOf('0.95 dB of 6.3 dB') !== -1, printed);
    // The PON result still names the class it is measured against.
    const ponOdn = signal.rows(downRow.result)[3];
    assert.strictEqual(ponOdn[0], 'ODN loss');
    assert.strictEqual(ponOdn[1], '11.53 dB of 32 dB gpon C+');
  });

  // The tab is an IIFE with no exports, so this guard is on the lines that make the fix work: the
  // second request, and the block that renders its answer. The rendering itself was checked on the
  // real page - a DOM count is not proof of rendering, and neither is a grep.
  test('the Signal tab asks for the upstream direction and renders a block per direction', function () {
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    assert.ok(app.indexOf('function renderSignal') !== -1, 'renderSignal not found');
    const end = app.indexOf('function renderCable');
    const slice = app.slice(app.indexOf('function loadBudgetPair'), end === -1 ? app.length : end);
    assert.ok(slice.indexOf("direction: 'up'") !== -1,
      'the tab does not ask for the upstream direction, so the failing half is invisible again');
    assert.ok(slice.indexOf('GFSignal.merge(') !== -1, 'the tab does not join the two passes');
    assert.ok(slice.indexOf('directionBlock(card.down)') !== -1, 'the downstream block is not rendered');
    assert.ok(slice.indexOf('directionBlock(card.up)') !== -1, 'the upstream block is not rendered');
    assert.ok(slice.indexOf('upError') !== -1, 'an upstream pass that fails to run is dropped in silence');
    assert.ok(app.indexOf('GFSignal.rows(') !== -1, 'the card builds its own figures again');
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
