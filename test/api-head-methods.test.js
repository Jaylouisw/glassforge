'use strict';
// `HEAD` follows `GET` - docs/API.md says so, and the method gate already advertises it
// (`Allow: GET, HEAD`). Node suppresses the body of a HEAD response, so a read handler only has to
// recognise the method. Four of them did not: the gate let HEAD through and the handler then
// answered `405 method not allowed` on /api/projects and `404 no such endpoint` on a project, its
// BOM and its strand page - for endpoints that exist, that the server had just said answer HEAD.
// A monitoring probe that HEADs a project to see whether it is there was told it is not.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-head-'));
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
        resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) });
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

  const created = await request('POST', '/api/projects', { name: 'head probe', olt: 'gpon-c-plus-8' });
  const project = JSON.parse(created.raw.toString('utf8'));
  const added = await request('POST', '/api/projects/' + project.id + '/ops',
    { op: 'add-node', node: { id: 'n2', type: 'ont', model: 'gpon-ont-4ge', lat: 51.5, lon: -0.1 } });
  assert.strictEqual(added.status, 200);
  const span = await request('POST', '/api/projects/' + project.id + '/ops',
    { op: 'add-span', span: { from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 1200 } });
  assert.strictEqual(span.status, 200);

  const reads = [
    '/api/health',
    '/api/parts',
    '/api/parts/cable/g652d-loose-12',
    '/api/projects',
    '/api/projects/' + project.id,
    '/api/projects/' + project.id + '/bom',
    '/api/projects/' + project.id + '/strands',
    '/api/design/splitter?ratio=8'
  ];
  const pairs = [];
  for (const pathname of reads) {
    pairs.push({ pathname: pathname, get: await request('GET', pathname), head: await request('HEAD', pathname) });
  }
  const missing = await request('HEAD', '/api/projects/nosuchproject/bom');

  test('every read endpoint answers HEAD exactly as it answers GET', function () {
    for (const pair of pairs) {
      const get = pair.get;
      const head = pair.head;
      assert.strictEqual(get.status, 200, 'GET ' + pair.pathname + ' answered ' + get.status);
      assert.strictEqual(head.status, 200,
        'HEAD ' + pair.pathname + ' answered ' + head.status + ' - it answers GET, and Allow advertises HEAD');
      // A HEAD carries the headers the GET would, and no body: that is what makes it useful as a
      // liveness check without paying for the payload.
      assert.strictEqual(head.headers['content-length'], get.headers['content-length'],
        'HEAD ' + pair.pathname + ' must report the body size the GET would have');
      assert.strictEqual(head.raw.length, 0, 'HEAD ' + pair.pathname + ' sent a body');
    }
  });

  test('a HEAD of something that is not there is still a 404, not a 200', function () {
    assert.strictEqual(missing.status, 404);
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
