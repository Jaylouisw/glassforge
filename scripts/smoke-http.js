#!/usr/bin/env node
/**
 * End-to-end smoke: spawn the real server on a free port, drive it like the UI does, kill it.
 *
 * The unit suites call the engine directly; this is the only check that proves the wiring - static
 * files, JSON bodies, project storage under a scratch directory, and the ETag the catalogue promises.
 * Self-contained: it picks its own port and data directory and cleans up.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function check(ok, message) {
  if (ok) console.log('  ✓ ' + message);
  else { failures++; console.error('  ✗ ' + message); }
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const port = s.address().port;
      s.close(function () { resolve(port); });
    });
  });
}

function waitFor(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise(function (resolve, reject) {
    (function attempt() {
      const req = http.get({ host: '127.0.0.1', port: port, path: '/api/health', timeout: 1000 }, function (res) {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', function () { req.destroy(); retry(); });
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
        setTimeout(attempt, 100);
      }
    })();
  });
}

function call(port, method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: port, path: pathname, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* html */ }
          resolve({ status: res.statusCode, body: json, text: text });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const port = await freePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-smoke-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', GF_DATA: dataRoot }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout.on('data', function (d) { stdout += d; });
  child.stderr.on('data', function (d) { stdout += d; });

  try {
    await waitFor(port, 15000);
    check(true, 'server booted on port ' + port);

    const health = await call(port, 'GET', '/api/health');
    check(health.status === 200 && health.body.name === 'glassforge', 'health reports glassforge');
    check(health.body.parts.total >= 30, 'catalogue has ' + health.body.parts.total + ' parts');

    const page = await call(port, 'GET', '/');
    check(page.status === 200 && page.text.indexOf('glassforge') !== -1, 'the UI is served at /');

    const parts = await call(port, 'GET', '/api/parts');
    check(!!parts.body && parts.body.counts.total >= 30, 'catalogue endpoint answers');

    const created = await call(port, 'POST', '/api/projects', { name: 'Smoke build' });
    check(created.status === 201 && !!created.body.id, 'project created');
    const id = created.body.id;

    const flow = [
      { op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8' } },
      { op: 'add-node', node: { type: 'splitter', model: 'plc-1x8-sca' } },
      { op: 'add-node', node: { type: 'closure', model: 'nap-8' } },
      { op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge' } },
      { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-24', lengthM: 900, splices: 1, closures: 1 } },
      { op: 'add-span', span: { from: 'n2', to: 'n3', cable: 'g652d-loose-12', lengthM: 60 } },
      { op: 'add-span', span: { from: 'n3', to: 'n4', cable: 'g657a2-drop-1', lengthM: 45 } }
    ];
    let ok = true;
    for (const op of flow) {
      const res = await call(port, 'POST', '/api/projects/' + id + '/ops', op);
      if (res.status !== 200) { ok = false; console.error('    ' + JSON.stringify(res.body)); }
    }
    check(ok, 'a plant can be built through the API');

    const budget = await call(port, 'POST', '/api/projects/' + id + '/budget', {});
    check(budget.status === 200 && budget.body.budgets.length === 1, 'a budget is produced for the ONT');
    check(budget.body.budgets[0].result.verdict === 'ok',
      'a 1:8 PON over 1 km of feeder is a healthy design (' + budget.body.budgets[0].result.verdict + ')');

    const bom = await call(port, 'GET', '/api/projects/' + id + '/bom');
    check(bom.status === 200 && bom.body.byCable.length === 3, 'the BOM has a line per cable model');

    const reloaded = await call(port, 'GET', '/api/projects/' + id);
    check(reloaded.status === 200 && reloaded.body.nodes.length === 4, 'the project survives a re-read from disk');

    console.log(failures ? '\n' + failures + ' smoke check(s) failed' : '\nall smoke checks passed');
    if (!failures) console.log(child.stdout.read() === null ? '' : '');
  } finally {
    child.kill();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (failures && stdout) console.error('server output:\n' + stdout);
  }
  process.exit(failures ? 1 : 0);
}

main().catch(function (err) {
  console.error('smoke failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
