'use strict';
// The printed splice schedule is the document a crew carries into the manhole, and a 24-fibre tube is
// the one cable where a colour repeats. gh#258 fixed the wording in the engine rows, but the page a
// crew signs was only asserted for the bundled (12-fibre) case: `row.colourLabel || row.colour` could
// lose the marking and every suite would still pass. This drives the real `/print/project/:id` page.
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
  // One 24-fibre tube: fibre 13 repeats blue with a black tracer; fibre 20 repeats black, so its
  // tracer is white or it cannot be read in the tray. Fibre 1 stays plain.
  const added = await request('POST', '/api/projects/' + id + '/ops', {
    op: 'add-span',
    span: { from: olt, to: closure, cable: 'atlas-lite-airblown-24', lengthM: 800, strands: [1, 13, 20] }
  });
  assert.strictEqual(added.status, 200, 'a 24-fibre tube span must be accepted: ' +
    JSON.stringify(added.body && added.body.error));

  const page = await request('GET', '/print/project/' + id);

  test('the printed schedule words the marking on a repeated colour', function () {
    assert.strictEqual(page.status, 200);
    const html = page.raw.toString('utf8');
    assert.ok(html.indexOf('Splice schedule') !== -1, 'no splice schedule on the page');
    assert.ok(html.indexOf('T01-F01') !== -1 && html.indexOf('T01-F13') !== -1,
      'both tray addresses must be printed');
    // Two plain blues in one tray is the defect: T01-F13 must differ from T01-F01 on the page.
    assert.ok(html.indexOf('blue with black tracer') !== -1,
      'the sheet does not name the black tracer for T01-F13');
    assert.ok(html.indexOf('black with white tracer') !== -1,
      'the repeated black (position 20) needs its white tracer');
  });

  test('a fibre on the base twelve still prints the plain colour', function () {
    const html = page.raw.toString('utf8');
    // The swatch span carries no text; the cell's text is the colour that follows `</span>`.
    assert.ok(html.indexOf('"></span>blue<') !== -1, 'T01-F01 lost its plain blue');
    assert.ok(html.indexOf('blue with black tracer') !== -1, 'and F13 kept its marking');
  });

  await new Promise(function (resolve) { server.close(resolve); });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  done();
}

main().catch(function (err) {
  console.error('FAIL suite crashed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
