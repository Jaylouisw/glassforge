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
  // 1:4 (7.2 dB) over 600 m of G.652.D (0.13 dB) plus 2 splices and 2 connectors is about 8.4 dB,
  // an ODN loss no C+ line card can overdrive - the warning list must stay empty.
  const clean = await request('POST', '/api/projects', { name: 'Clean' });
  const cleanId = clean.body.id;
  for (const step of [
    { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } },
    { op: 'add-node', node: { type: 'splitter', model: 'plc-1x4-sca', name: 'Splitter' } },
    { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa 40' } },
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 600, splices: 2, closures: 1 } },
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

  // The app's Signal tab is the other surface. It is an IIFE with no exports, so the guard here is
  // that the card builder reads the field the engine fills - the rendering itself was verified on
  // the real page (screenshot on the PR), which is the only proof of rendering that exists.
  test('the Signal tab reads budget warnings, not only its reasons', function () {
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const card = app.slice(app.indexOf('function renderSignal'), app.indexOf('function renderStrands') === -1
      ? app.length : app.indexOf('function renderStrands'));
    assert.ok(card.length > 0, 'renderSignal not found');
    assert.ok(card.indexOf('r.warnings') !== -1,
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
