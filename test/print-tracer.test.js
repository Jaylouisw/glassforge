'use strict';
// The printed splice schedule is the document a crew carries into the manhole, and a 24-fibre tube is
// the one cable where a colour can repeat. This drives the real `/print/project/:id` page and asserts
// the words and the stripe a crew reads, not just the engine row (gh#258).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-print-tracer-'));
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

  const project = await request('POST', '/api/projects', { name: 'Tracer print' });
  const id = project.body.id;
  let state = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT', lat: 51.5, lon: -0.1 }
  });
  const olt = state.body.nodes.find(function (n) { return n.type === 'olt'; }).id;
  state = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-node', node: { type: 'closure', model: 'mufa-inline-24', name: 'CAB-1', lat: 51.502, lon: -0.1 }
  });
  const closure = state.body.nodes.find(function (n) { return n.type === 'closure'; }).id;
  // One 24-fibre tube: fibre 13 repeats blue with a black tracer, fibre 20 repeats black (white tracer).
  const added = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-span',
    span: { from: olt, to: closure, cable: 'atlas-lite-airblown-24', lengthM: 800, strands: [1, 13, 20] }
  });
  assert.strictEqual(added.status, 200, 'a 24-fibre tube span must be accepted: ' +
    JSON.stringify(added.body && added.body.error));

  const page = await request('GET', '/print/project/' + id);
  test('the printed schedule words the tracer on a 24-fibre tube', function () {
    assert.strictEqual(page.status, 200);
    const html = page.raw.toString('utf8');
    assert.ok(html.indexOf('Splice schedule') !== -1, 'no splice schedule on the page');
    assert.ok(html.indexOf('T01-F01') !== -1 && html.indexOf('T01-F13') !== -1, 'both tray addresses must be printed');
    // Two plain blues in one tray is the defect; the plan must say which blue carries the tracer.
    assert.ok(html.indexOf('blue with black tracer') !== -1, 'the sheet does not name the black tracer: ' + html.slice(0, 200));
    assert.ok(html.indexOf('black with white tracer') !== -1, 'the repeated black needs its white tracer');
  });

  test('the printed swatch carries the tracer stripe, not one flat block', function () {
    const html = page.raw.toString('utf8');
    assert.ok(html.indexOf('class="swatch tracer-black"') !== -1, 'no black tracer stripe on the swatch');
    assert.ok(html.indexOf('class="swatch tracer-white"') !== -1, 'no white tracer stripe on the swatch');
  });

  await new Promise(function (resolve) { server.close(resolve); });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  done();
}

main().catch(function (err) {
  console.error('FAIL suite crashed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
