'use strict';
// The printed splice schedule is the document a crew carries into the manhole. A bundled span's row
// must name the cable as well as the tray, because the strand index runs across every cable while a
// tray does not (gh#95). This drives the real `/print/project/:id` page, not just the engine rows, so
// the column the crew reads is the one asserted.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-print-bundle-'));
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
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (err) { /* HTML page */ }
        resolve({ status: res.statusCode, body: json, raw: buf });
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

  const project = await request('POST', '/api/projects', { name: 'Bundled print' });
  const id = project.body.id;
  let state = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 }
  });
  const olt = state.body.nodes.find(function (n) { return n.type === 'olt'; }).id;
  state = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-node', node: { type: 'closure', model: 'inline-closure-24', name: 'CAB-1', lat: 51.502, lon: -0.1 }
  });
  const closure = state.body.nodes.find(function (n) { return n.type === 'closure'; }).id;
  // 2 x 12: strand 13 is the first fibre of cable 2 and strand 18 its sixth.
  const added = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-span',
    span: { from: olt, to: closure, cable: 'g652d-loose-12', bundles: 2, lengthM: 800, strands: [1, 13, 18] }
  });
  assert.strictEqual(added.status, 200, 'a bundled span with 24-fibre capacity must be accepted: ' +
    JSON.stringify(added.body && added.body.error));

  const page = await request('GET', '/print/project/' + id);
  test('the printed splice schedule names the cable on a bundled span', function () {
    assert.strictEqual(page.status, 200);
    const html = page.raw.toString('utf8');
    assert.ok(html.indexOf('Splice schedule') !== -1, 'no splice schedule on the page');
    // Cable-qualified: cable 2, tube 1, fibre 6. The bare T02-F06 is a tube neither 12-fibre cable has.
    assert.ok(html.indexOf('C02/T01-F06') !== -1, 'the sheet does not name the cable for strand 18');
    assert.ok(html.indexOf('C02/T01-F01') !== -1, 'the sheet does not name the cable for strand 13');
    assert.ok(html.indexOf('>T02-F06<') === -1, 'a row still prints a tray that does not exist');
    // Strand 1 is cable 1: qualified too, so the column reads consistently.
    assert.ok(html.indexOf('C01/T01-F01') !== -1, 'cable 1 is not named on the bundled span');
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
