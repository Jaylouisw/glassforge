'use strict';
// The plant-level band note sized a pad for one direction of an ODN that carries two.
//
// A PON is two links over one loss: the OLT launches into the ONT (1490 nm) and the ONT launches into
// the OLT (1310 nm, the more lossy wavelength). Overload is judged at the floor of the *launching*
// end's window, so a plant can be clean at the floor in both directions and in the band at the top in
// both - and the two bands are not the same width, because the ends are different optics with
// different windows. `launchWindowNote` built its sentence from the rows of one pass (downstream), so
// the pad it named was sized for the ONT receiver alone. On the C+ 1:8 design below the downstream
// band needs 3 dB and the upstream band needs 5 dB, with every ONT `ok` in both directions: a crew that
// fits the 3 dB pad the report names leaves the OLT receiver 1.45 dB over its overload point whenever
// the ONT runs at the top of its window. At a longer feeder the downstream band is behind the plant and
// the upstream one is not, and the report said nothing at all.
//
// Numbers, all from `opticalBudget` on the same design (3 km of G.652.D, 1:8 PLC, 4 splices,
// 2 connectors, gpon-c-plus-8 + gpon-ont-4ge):
//
//   downstream  0.33 dB/km: 0.99 fibre + 10.50 splitter + 0.60 connectors + 0.40 splice = 12.16 dB of
//               ODN.  +3 - 12.16 = -9.16 dBm on a -8 dBm ONT overload: inside it, `ok`.  +7 - 12.16 =
//               -5.16 dBm, 2.84 dB over, so ceil(2.84) = 3 dB of pad.
//   upstream    0.35 dB/km: 1.05 fibre + 10.50 + 0.60 + 0.40 = 12.55 dB.  +0.5 - 12.55 = -12.05 dBm on
//               a -12 dBm OLT overload: inside it, `ok`.  +5 - 12.55 = -7.55 dBm, 4.45 dB over, so
//               ceil(4.45) = 5 dB of pad - the size that is actually needed, because a pad is ODN loss
//               and one pad in the ODN serves both receivers.
//
// The verdicts do not move (#111's decision is still Jay's): both rows stay `ok`. Only the size the
// report names changes, and the direction that binds is named.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');
const { test, assert, done } = require('./harness');
const { createServer } = require('../server/index');

const registry = engine.createRegistry();

// 3 km of G.652.D through a 1:8 PLC, 4 splices, 2 connectors: ODN 12.16 dB downstream, 12.55 dB up,
// so both verdicts are `ok` and both directions sit in the launch-window band.
function design(direction) {
  return {
    direction: direction,
    olt: { model: 'gpon-c-plus-8' },
    ont: { model: 'gpon-ont-4ge' },
    spans: [{ lengthM: 3000, cable: 'g652d-loose-12' }],
    splitters: [{ model: 'plc-1x8-sca', ratio: 8 }],
    splices: 4,
    connectors: 2
  };
}

const down = engine.budget.opticalBudget(design('down'), registry);
const up = engine.budget.opticalBudget(design('up'), registry);
const downRow = { ont: 'n2', name: 'House 1', result: down };
const upRow = { ont: 'n2', name: 'House 1', result: up };

// An estate of 12 homes a short hop from the PoP: the same topology auto-design would build.
function estate(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ label: 'House ' + (i + 1), lat: 51.5 + i * 0.0004, lon: -0.1 + Math.sin(i / 5) * 0.0004 });
  }
  return points;
}

// 2.9 km south of the first house: ODN 12.31 dB downstream and 12.79 dB upstream, so every ONT is `ok`
// in both directions and only the launch-window band is left to say - 3 dB downstream, 5 dB upstream.
const NEAR = { lat: 51.474, lon: -0.1006, name: 'PoP' };
const synthesised = engine.design.synthesise(estate(12), {
  headEnd: NEAR,
  pon: { olt: 'gpon-c-plus-8', splitterRatio: 8, ont: 'gpon-ont-4ge', cables: ['g652d-loose-12', 'g657a2-drop-2'] }
}, registry);

// ---- the printed plan ---------------------------------------------------------------------------
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassforge-band-both-'));
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

async function seedPlant(feederM, name) {
  // A 1:16 PLC over 3 km of G.652.D with a 40 m drop per ONT. Downstream ODN 15.17 dB is past the top
  // of the C+ band (-8.17 dBm at the +7 dBm ceiling), but upstream adds 0.06 dB at 1310 nm and lands at
  // 15.23 dB: -14.73 dBm at the ONT's +0.5 dBm floor (clean) and -10.23 dBm at its +5 dBm ceiling,
  // 1.77 dB over the OLT receiver's -12 dBm overload - a 2 dB pad, and the only band this plant has.
  const created = await request('POST', '/api/projects', { name: name });
  const id = created.body.id;
  async function op(step) {
    const answer = await request('POST', '/api/projects/' + id + '/ops', step);
    if (answer.status !== 200) throw new Error('seed op ' + step.op + ' failed: ' + answer.text);
    return answer.body;
  }
  await op({ op: 'add-node', node: { type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' } });
  const splitter = await op({ op: 'add-node', node: { type: 'splitter', model: 'plc-1x16-sca',
    name: 'Splitter', lat: 51.5, lon: -0.1 } });
  const oltId = splitter.nodes[0].id;
  const splitterId = splitter.nodes[1].id;
  await op({ op: 'add-span', span: { from: oltId, to: splitterId, cable: 'g652d-loose-24', lengthM: feederM } });
  for (let i = 1; i <= 16; i++) {
    const added = await op({ op: 'add-node', node: { type: 'ont', model: 'gpon-ont-4ge', name: 'Casa ' + i,
      lat: 51.5 + i * 0.00002, lon: -0.1 } });
    const ontId = added.nodes[added.nodes.length - 1].id;
    await op({ op: 'add-span', span: { from: splitterId, to: ontId, cable: 'g657a2-drop-1', lengthM: 40 } });
  }
  return id;
}

async function main() {
  test('both directions are ok and both are in the band: the premise of this suite', function () {
    assert.strictEqual(down.verdict, 'ok', JSON.stringify(down.reasons));
    assert.strictEqual(up.verdict, 'ok', JSON.stringify(up.reasons));
    assert.strictEqual(down.launchWindowPad.padDb, 3, 'ceil(2.84) = 3 downstream');
    assert.strictEqual(up.launchWindowPad.padDb, 5, 'ceil(4.45) = 5 upstream');
    assert.strictEqual(up.direction, 'up', 'the row must say which direction it budgeted');
  });

  test('the note sizes one pad for both receivers and names the direction that binds', function () {
    const note = engine.budget.launchWindowNote([downRow], { other: [upRow] });
    assert.ok(note, 'a plant in the band in both directions produced no note');
    assert.strictEqual(note.padDb, 5, 'the pad to buy is the larger of the two bands: ' + note.text);
    assert.ok(note.text.indexOf('5 dB of inline pad at the OLT') !== -1,
      'the size a crew orders is the one that clears both receivers: ' + note.text);
    assert.ok(note.text.indexOf('ONT gpon-ont-4ge launch window') !== -1,
      'the sentence must say which window the binding figure came from: ' + note.text);
    assert.ok(note.text.indexOf('the downstream direction needs 1 x 3 dB') !== -1,
      'and what the other direction asked for, so the larger size is not arbitrary: ' + note.text);
    assert.ok(note.text.indexOf('so size it for the larger') !== -1, note.text);
  });

  test('one pad size for both directions needs no clause about the other one', function () {
    const twin = { ont: 'n2', name: 'House 1', result: Object.assign({}, up, {
      launchWindowPad: { overDb: 4.45, padDb: 3, maxPadDb: 20, atTxDbm: 5, fits: true }
    }) };
    const note = engine.budget.launchWindowNote([downRow], { other: [twin] });
    assert.ok(note.text.indexOf('5 dB of inline pad') === -1, note.text);
    assert.ok(note.text.indexOf('the other direction') === -1 && note.text.indexOf('needs 1 x') === -1,
      'equal sizes are one purchase and one sentence: ' + note.text);
  });

  test('a plant the downstream band has left is still told about the upstream one', function () {
    // A 1:16 PLC (13.80 dB) puts the fixed loss high enough that the 1310 nm penalty over 3 km is only
    // 0.39 dB: downstream ODN 15.26 dB is past the C+ band's 15 dB top, upstream ODN 15.65 dB is still
    // inside its 17 dB top. Over a longer feeder the two penalties separate and the upstream band is
    // left too - so this is the shape of plant that had no band note at all.
    const flat = function (dir) {
      return Object.assign(design(dir), {
        spans: [{ lengthM: 3000, cable: 'g652d-loose-24' }],
        splitters: [{ model: 'plc-1x16-sca', ratio: 16 }],
        splices: 2
      });
    };
    const past = engine.budget.opticalBudget(flat('down'), registry);
    const pastUp = engine.budget.opticalBudget(flat('up'), registry);
    assert.strictEqual(past.launchWindowPad, null, 'the downstream band is behind this plant');
    assert.ok(pastUp.launchWindowPad, 'the upstream band is not');
    assert.strictEqual(pastUp.launchWindowPad.padDb, 2, 'ceil(1.35) = 2 dB');
    const note = engine.budget.launchWindowNote([{ ont: 'n2', name: 'House 1', result: past }],
      { other: [{ ont: 'n2', name: 'House 1', result: pastUp }] });
    assert.ok(note, 'the only band on this plant is upstream, and it was reported as clean');
    assert.ok(note.text.indexOf('the OLT receiver') !== -1, note.text);
    assert.ok(note.text.indexOf('ONT gpon-ont-4ge launch window') !== -1, note.text);
    assert.ok(note.text.indexOf('every ONT laser launches at 0.5 dBm') !== -1,
      'the floor launch named must belong to the end that launches in that direction: ' + note.text);
  });

  test('the synthesised plan carries the pad that clears both receivers', function () {
    const warnings = (synthesised.best && synthesised.best.warnings) || [];
    const band = warnings.filter(function (w) { return w.indexOf('overload point only at the bottom of') !== -1; });
    assert.strictEqual(band.length, 1, JSON.stringify(warnings));
    // Both directions `ok`, so the only band sentence is the note's - and it leads with the upstream
    // figure because 5 dB is the size that binds. No `fail` sentence here to carry it instead.
    assert.ok(band[0].indexOf('the OLT receiver') !== -1,
      'the report still sizes the pad from the downstream band alone: ' + band[0]);
    // The upstream pad each ONT needs is ceil(17 - its upstream ODN): the ONTs past 13 dB need 4 dB and
    // the rest 5. 0.10 dB less ODN at every ONT (the splitter site's contracted stub, #39) moved three
    // of them across 13 dB, so the mixture was 6 x 5 dB + 6 x 4 dB and is now 9 x 5 dB + 3 x 4 dB.
    assert.ok(band[0].indexOf('(9 x 5 dB, 3 x 4 dB)') !== -1 && band[0].indexOf('the downstream direction needs') !== -1,
      'the sizes that bind are the upstream ones, and the downstream ask is named beside them: ' + band[0]);
  });

  test('a plant clean in both directions still has no note', function () {
    const note = engine.budget.launchWindowNote(
      [{ ont: 'n2', name: 'H', result: Object.assign({}, down, { launchWindowPad: null }) }],
      { other: [{ ont: 'n2', name: 'H', result: Object.assign({}, up, { launchWindowPad: null }) }] });
    assert.strictEqual(note, null);
  });

  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;

  const id = await seedPlant(3000, 'Upstream band only');
  const printed = await request('GET', '/print/project/' + id);

  test('the page a crew signs off names the upstream band and its pad', function () {
    assert.strictEqual(printed.status, 200);
    assert.ok(printed.text.indexOf('ONT gpon-ont-4ge launch window') !== -1,
      'the plan prints no band note at all when only the upstream direction is in the band');
    assert.ok(printed.text.indexOf('2 dB of inline pad at the OLT') !== -1,
      'the pad this plant needs is 2 dB, sized at the ONT ceiling launch');
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
