'use strict';
// A budget warning is only worth computing if somebody reads it.
//
// The bug this exists for (#111): the engine learned to say "this link is clean only at the bottom
// of the launch window" and put it in `result.warnings` - and every surface dropped it. The Signal
// tab rendered `reasons` only, and the printed plan carried structural checks only, so a design
// that depends on a cold optic printed as "No errors and no warnings" and a signed-off plan said
// nothing. The engine's sentence was right; the callers never asked for it.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-warn-'));
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

// The #111 worked example: C+ at 3 km of G.652.D through a 1:8 splitter, 4 splices, 2 closures and
// a 60 m drop. ODN 11.9 dB sits inside the 11.0-15.0 dB blind zone: -8.87 dBm at +3 dBm is inside
// the ONT's -8 dBm overload point, and 3.13 dB above it at the +7 dBm top of the same window.
async function buildBlindZonePlant() {
  const created = await request('POST', '/api/projects', { name: 'Blind zone' });
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
  const budget = await request('POST', '/api/projects/' + id + '/budget', {});
  const row = budget.body.budgets[0];

  test('the blind zone is a warning on an okay verdict, not a silence and not a failure', function () {
    assert.strictEqual(row.result.verdict, 'ok',
      'the verdict stays where SPEC §4 puts it (#111) - the band is a warning, not a failure');
    assert.strictEqual(row.result.reasons.length, 0);
    assert.strictEqual(row.result.warnings.length, 1, JSON.stringify(row.result.warnings));
    assert.ok(/launch window/.test(row.result.warnings[0]), row.result.warnings[0]);
  });

  const printed = await request('GET', '/print/project/' + id);
  test('the printed plan carries the budget warning, attributed to the ONT it belongs to', function () {
    assert.strictEqual(printed.status, 200);
    assert.ok(printed.text.indexOf('launch window') !== -1,
      'the plan a crew signs off does not mention the launch window at all');
    assert.ok(printed.text.indexOf('Casa 30') !== -1,
      'a warning in a plan with more than one ONT must name the ONT it is about');
    assert.ok(printed.text.indexOf('No errors and no warnings') === -1,
      'the plan claims there is nothing to report while a budget warning exists');
  });

  // The other half of the guard: a design that is clean at every launch must still print as clean.
  //
  // This used to seed 1:4 over 600 m - about 8.4 dB of ODN - and call it clean because the *warning*
  // list was empty. It was not clean: 8.4 dB against a +3..+7 dBm C+ launch puts the ONT at -5.4 to
  // -1.4 dBm, over its -8 dBm overload point, so the budget was `fail` and the plan printed
  // "No errors and no warnings" over it (#138). A genuinely clean plant needs an ODN deep enough
  // that the top of the launch window is still inside overload: 1:8 (9.03 + 1.47 = 10.50) over
  // 20 km of G.652.D (4.40), 2 splices (0.20), connectors and the 40 m drop (0.51) = 15.61 dB.
  // Rx is -12.61 dBm at +3 dBm (17.39 dB of headroom) and -8.61 dBm at +7 dBm - 0.61 dB inside the
  // overload point, so neither `attenuator` nor the launch-window band is set.
  const clean = await request('POST', '/api/projects', { name: 'Clean' });
  const cleanId = clean.body.id;
  for (const step of [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca', name: 'Splitter' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 40' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 20000, splices: 2, closures: 1 } },
    { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 } }
  ]) {
    const answer = await request('POST', '/api/projects/' + cleanId + '/ops', step);
    if (answer.status !== 200) throw new Error('clean seed op failed: ' + answer.text);
  }
  const cleanBudget = await request('POST', '/api/projects/' + cleanId + '/budget', {});
  const cleanPrinted = await request('GET', '/print/project/' + cleanId);
  test('a design clean at every launch still prints as clean', function () {
    assert.strictEqual(cleanBudget.body.budgets[0].result.warnings.length, 0,
      JSON.stringify(cleanBudget.body.budgets[0].result.warnings));
    assert.ok(cleanPrinted.text.indexOf('No errors and no warnings.') !== -1,
      'the plan now claims a warning for a design with none');
  });

  // ---- the verdict itself, not only its warnings (#138) ------------------------------------------
  //
  // The plan's Checks section carried `project.check` (structural, and by its own comment it never
  // runs an optical budget) plus every budget's *warnings*. A budget's `reasons` - and the verdict
  // at all - were never asked for, so a link the engine calls `fail` printed "No errors and no
  // warnings." on the page a crew signs off.
  //
  // Numbers: B+ (28 dB class) through a 1:64 at 20 km of G.652.D with one closure and a 40 m drop.
  // The budget follows the topology, not `span.splices`: 20 km x 0.22 = 4.40, drop 0.01, one closure
  // = one splice 0.10, 2 connectors 0.60, 1:64 = 20.50 (18.06 ideal + 2.44 excess) -> ODN 25.61 dB.
  // Tx +1.5 dBm puts -24.11 dBm on a -27 dBm receiver: 2.89 dB of headroom, below the 3 dB margin,
  // so `fail`. At 11 km the fibre is 2.42 dB instead of 4.40: ODN 23.63 dB (2.42 + 0.01 drop + 0.10
  // splice + 0.60 connectors + 20.50 splitter), -22.13 dBm on the -27 dBm receiver = 4.87 dB of
  // headroom - inside the `marginal` band (< margin + 2) rather than failing.
  //
  // This used to seed 16 km. The printed plan now also budgets the upstream direction, and at 16 km
  // that direction is not marginal at all: 16 x 0.35 = 5.60 dB of 1310 nm fibre + 0.01 + 0.10 + 0.60
  // + 20.50 = 26.81 dB of ODN puts the ONT's +0.5 dBm at -26.31 dBm on a -28 dBm OLT receiver -
  // 1.69 dB of headroom against the 3 dB margin, a `fail`. The page printing that as an error is
  // correct, so this guard keeps both its assertions and only moves to a plant that is a decision in
  // both directions: at 11 km upstream is 25.06 dB, -24.56 dBm against -28 dBm = 3.44 dB, marginal.
  function longFeeder(metres, ontName) {
    return [
      { op: 'add-node', node: { type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' } },
      { op: 'add-node', node: { type: 'splitter', model: 'plc-1x64-sca', name: 'Splitter' } },
      { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-1ge', name: ontName } },
      { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-96', lengthM: metres, closures: 2 } },
      { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 40 } }
    ];
  }

  async function seedPlant(name, steps) {
    const created = await request('POST', '/api/projects', { name: name });
    const id = created.body.id;
    for (const step of steps) {
      const answer = await request('POST', '/api/projects/' + id + '/ops', step);
      if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
    }
    return id;
  }

  const failingId = await seedPlant('Failing link', longFeeder(20000, 'Casa 7'));
  const failingBudget = await request('POST', '/api/projects/' + failingId + '/budget', {});
  const failingRing = failingBudget.body.budgets[0].result;
  const failingPrinted = await request('GET', '/print/project/' + failingId);

  test('a budget that fails is an error on the printed plan, in its own words', function () {
    assert.strictEqual(failingRing.verdict, 'fail', 'the engine must call this link a failure first');
    assert.strictEqual(failingRing.reasons.length, 1, failingRing.reasons.join(' | '));
    assert.ok(failingPrinted.text.indexOf('No errors and no warnings') === -1,
      'the plan a crew signs off says there is nothing to report while its budget fails');
    assert.ok(failingPrinted.text.indexOf('Casa 7') !== -1,
      'a failing budget in a plan must name the ONT it is about');
    assert.ok(failingPrinted.text.indexOf(failingRing.reasons[0]) !== -1,
      'the plan does not carry the reason the engine gave: ' + failingRing.reasons[0]);
  });

  const marginalId = await seedPlant('Marginal link', longFeeder(11000, 'Casa 8'));
  const marginalBudget = await request('POST', '/api/projects/' + marginalId + '/budget', {});
  const marginalRing = marginalBudget.body.budgets[0].result;
  const marginalPrinted = await request('GET', '/print/project/' + marginalId);

  test('a marginal budget is a warning on the printed plan, never a failure and never silence', function () {
    assert.strictEqual(marginalRing.verdict, 'marginal', 'this plant is the marginal band');
    assert.strictEqual(marginalRing.reasons.length, 0, marginalRing.reasons.join(' | '));
    assert.ok(marginalPrinted.text.indexOf('No errors and no warnings') === -1,
      'a marginal design is a decision somebody has to make, and the plan says nothing');
    assert.ok(marginalPrinted.text.indexOf('Casa 8') !== -1,
      'the marginal line must name the ONT it is about');
    assert.ok(marginalPrinted.text.indexOf('marginal') !== -1,
      'the plan does not carry the verdict word the engine returned');
    assert.strictEqual(marginalPrinted.text.indexOf('class="err"'), -1,
      'a marginal verdict builds; only a fail is an error on the plan');
  });

  // The app's Signal tab is the other surface. It is an IIFE with no exports, so the guard here is
  // that the card builder reads the field the engine fills - the rendering itself was verified on
  // the real page (screenshot on the PR), which is the only proof of rendering that exists.
  //
  // This used to slice `renderSignal` to `renderStrands` and look for `r.warnings`. The tab learned
  // to draw both directions (#185) and the warning list moved into `directionBlock`, the function
  // both directions share, so the same assertion is made against the function that paints it. The
  // old slice still passes on the file while asserting nothing, which is why it is not kept.
  test('the Signal card reads budget warnings, not only its reasons', function () {
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const start = app.indexOf('function directionBlock');
    assert.ok(start !== -1, 'directionBlock not found');
    const end = app.indexOf('function renderSignal');
    const card = app.slice(start, end === -1 ? app.length : end);
    assert.ok(card.length > 0, 'the Signal direction block was not found');
    assert.ok(card.indexOf('result.warnings') !== -1,
      'the Signal card drops result.warnings, so the launch-window warning is invisible where the verdict is read');
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
