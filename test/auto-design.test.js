'use strict';
// Topology synthesis: the same demand must produce the same design, and the design must be buildable.
const { test, assert, throws, close, done } = require('./harness');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const registry = engine.createRegistry();

function street(n, stepDeg, start) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({
      label: 'House ' + (i + 1),
      lat: (start ? start.lat : 51.5) + i * stepDeg,
      lon: (start ? start.lon : -0.1) + Math.sin(i / 5) * 0.0004
    });
  }
  return points;
}

const HEAD_END = { lat: 51.499, lon: -0.1006, name: 'PoP' };

test('the same demand and options produce byte-identical output', function () {
  const demand = street(12, 0.0004);
  const a = engine.design.synthesise(demand, { headEnd: HEAD_END }, registry);
  const b = engine.design.synthesise(demand, { headEnd: HEAD_END }, registry);
  assert.strictEqual(JSON.stringify(a.plant), JSON.stringify(b.plant));
  assert.strictEqual(a.technology, b.technology);
  assert.strictEqual(a.best.metrics.fibreMetres, b.best.metrics.fibreMetres);

  // That comparison is only worth something while the design path cannot read a clock or an RNG:
  // put either in it and two consecutive runs differ, so this test would flake rather than fail -
  // which hides the regression instead of reporting it. So the sources are scanned, and the scan is
  // what gives this test teeth. `project.js` is exempt from the clock rule alone: it stamps
  // `updatedAt` from an injectable clock, and that timestamp is metadata, not part of a plant.
  const engineDir = path.join(__dirname, '..', 'engine');
  const rng = [];
  const clock = [];
  for (const name of fs.readdirSync(engineDir).sort()) {
    if (!/\.js$/.test(name)) continue;
    fs.readFileSync(path.join(engineDir, name), 'utf8').split(/\r?\n/).forEach(function (line, i) {
      const at = name + ':' + (i + 1) + ' ' + line.trim();
      if (/\bMath\.random\b/.test(line)) rng.push(at);
      if (name !== 'project.js' && /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b|\bprocess\.hrtime\b/.test(line)) clock.push(at);
    });
  }
  assert.deepStrictEqual(rng, [], 'engine/ must not use Math.random: ' + rng.join(' | '));
  assert.deepStrictEqual(clock, [], 'the design path must not read the clock: ' + clock.join(' | '));
});

test('every demand point becomes exactly one ONT', function () {
  const demand = street(9, 0.0004);
  const out = engine.design.synthesise(demand, { headEnd: HEAD_END }, registry);
  const onts = out.plant.nodes.filter(function (n) { return n.type === 'ont'; });
  assert.strictEqual(onts.length, demand.length);
  const labels = onts.map(function (n) { return n.name; }).sort();
  assert.deepStrictEqual(labels, demand.map(function (p) { return p.label; }).sort());
});

test('the winning plant validates and every ONT on it has a passing budget', function () {
  const out = engine.design.synthesise(street(12, 0.0004), { headEnd: HEAD_END }, registry);
  const validation = engine.network.validate(out.plant, registry);
  assert.deepStrictEqual(validation.errors, [], JSON.stringify(validation.errors, null, 2));
  const budgets = engine.network.allOntBudgets(out.plant, registry);
  assert.strictEqual(budgets.length, 12);
  for (const entry of budgets) {
    assert.ok(!entry.error, entry.error);
    assert.notStrictEqual(entry.result.verdict, 'fail', entry.ont + ': ' + entry.result.reasons.join('; '));
  }
});

test('a longer street is won by the PON on fibre-metres, and the reason is checkable', function () {
  const out = engine.design.synthesise(street(40, 0.00045), { headEnd: HEAD_END }, registry);
  assert.strictEqual(out.technology, 'pon', 'PON should win a 2 km street: ' + out.rationale.join(' | '));
  const pon = out.candidates.find(function (c) { return c.technology === 'pon' && c.feasible; });
  const active = out.candidates.find(function (c) { return c.technology === 'active-tree' && c.feasible; });
  assert.ok(pon.metrics.fibreMetres < active.metrics.fibreMetres,
    'PON ' + pon.metrics.fibreMetres + ' vs active ' + active.metrics.fibreMetres);
  assert.ok(out.rationale[0].indexOf('Chosen:') === 0);
  assert.ok(out.rationale.some(function (line) { return line.indexOf('Rejected') === 0; }));
});

test('forcing a technology returns only that technology', function () {
  const active = engine.design.synthesise(street(8, 0.0004), { headEnd: HEAD_END, technology: 'active' }, registry);
  assert.ok(active.candidates.every(function (c) { return c.technology.indexOf('active') === 0; }));
  const pon = engine.design.synthesise(street(8, 0.0004), { headEnd: HEAD_END, technology: 'pon' }, registry);
  assert.ok(pon.candidates.every(function (c) { return c.technology === 'pon'; }));
});

test('a design with no head-end is refused', function () {
  throws(function () { engine.design.synthesise(street(3, 0.0004), {}, registry); }, 'headEnd');
  throws(function () { engine.design.synthesise(street(3, 0.0004), { headEnd: { lat: 999, lon: 0 } }, registry); }, 'valid coordinate');
});

test('one address is a legal design', function () {
  const out = engine.design.synthesise([{ label: 'Only house', lat: 51.501, lon: -0.1 }], { headEnd: HEAD_END }, registry);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.plant.nodes.filter(function (n) { return n.type === 'ont'; }).length, 1);
});

test('routeFactor scales the measured runs', function () {
  const demand = street(6, 0.0004);
  const direct = engine.design.synthesise(demand, { headEnd: HEAD_END, routeFactor: 1.0, technology: 'active' }, registry);
  const detour = engine.design.synthesise(demand, { headEnd: HEAD_END, routeFactor: 1.5, technology: 'active' }, registry);
  assert.ok(detour.best.metrics.cableM > direct.best.metrics.cableM * 1.4);
  assert.ok(direct.routeMethod.indexOf('straight-line') !== -1);
});

test('an infeasible candidate is reported with reasons, not dropped', function () {
  // A 1m drop limit forces one splitter per house, which overruns an 8-port OLT.
  const out = engine.design.synthesise(street(24, 0.0009), {
    headEnd: HEAD_END,
    technology: 'pon',
    pon: { ratios: [8], maxDropM: 1 }
  }, registry);
  assert.strictEqual(out.candidates.length >= 1, true);
  const candidate = out.candidates[0];
  assert.strictEqual(candidate.feasible, false);
  assert.ok(candidate.reasons.length > 0);
  assert.ok(candidate.reasons.join(' ').indexOf('PON port') !== -1, candidate.reasons.join(' | '));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plant, null);
});

test('a long two-fibre span is a cable run, not a drop', function () {
  // Two fibres over 1.2 km is not a drop: drop cable is not what gets pulled between buildings, and
  // designing it that way produces a BOM nobody can buy.
  const long = engine.design.cableForSpan(2, 1200, engine.design.DEFAULT_LADDER, registry);
  assert.ok(long.fiberCount >= 12, 'a 1.2 km two-fibre span chose ' + long.model);

  const short = engine.design.cableForSpan(2, 120, engine.design.DEFAULT_LADDER, registry);
  assert.strictEqual(short.fiberCount, 2, 'a 120 m two-fibre span should stay drop cable, got ' + short.model);

  const oneFibre = engine.design.cableForSpan(1, 50, engine.design.DEFAULT_LADDER, registry);
  assert.strictEqual(oneFibre.fiberCount, 1, 'a short single-fibre drop is drop-1, got ' + oneFibre.model);

  // And through a real design: two points 1.2 km apart, one tree edge.
  const far = engine.design.synthesise([
    { label: 'Near', lat: 51.5000, lon: -0.1 },
    { label: 'Far', lat: 51.5108, lon: -0.1 }
  ], { headEnd: { lat: 51.4995, lon: -0.1 }, technology: 'active' }, registry);
  // No exemption for `purpose: 'drop'` any more. It used to skip drops, which is how a 400 m spur
  // kept its builder-supplied drop cable while every other long span obeyed the rule.
  for (const span of far.plant.spans) {
    if (span.lengthM <= engine.design.DROP_CABLE_MAX_M) continue;
    const cable = registry.get('cable', span.cable);
    assert.ok(cable.fiberCount >= 12, span.id + ' is ' + span.lengthM + ' m on ' + cable.model);
  }
});

test('a drop longer than the drop-cable limit is a cable run, not drop cable', function () {
  // The same rule as a long two-fibre span, one span further out: a rural address 400 m from the
  // nearest mapped street is a real drop length (that is what `maxSnapM` is for), and drop cable over
  // 300 m is a product nobody pulls. This span used to keep the builder's hard-coded `terminalCable`,
  // so the BOM bought 457 m of 1-fibre drop - the one product the limit exists to keep out of it.
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push({ lat: 51.5, lon: -0.1010 + i * 0.0002 });
  const out = engine.design.synthesise([
    { label: 'Far Farm', lat: 51.5 + 400 / 111320, lon: -0.1 },
    { label: 'Near House', lat: 51.5002, lon: -0.0995 }
  ], {
    headEnd: { lat: 51.5, lon: -0.1010 }, technology: 'pon', pon: { ratios: [8] },
    network: { edges: [{ id: 'main', coords: coords }] }, maxSnapM: 600
  }, registry);
  const drops = out.plant.spans.filter(function (s) { return s.purpose === 'drop'; });
  const long = drops.filter(function (s) { return s.lengthM > engine.design.DROP_CABLE_MAX_M; });
  assert.strictEqual(long.length, 1, 'one 400 m drop, got ' + JSON.stringify(drops.map(function (s) { return [s.id, s.lengthM, s.cable]; })));
  const longCable = registry.get('cable', long[0].cable);
  assert.ok(longCable.fiberCount >= 12, 'a 400 m drop bought ' + longCable.model + ' (' + longCable.fiberCount + 'F)');
  // The short drop on the same design is unchanged: drop cable is right when the run is a drop.
  const short = drops.filter(function (s) { return s.lengthM <= engine.design.DROP_CABLE_MAX_M; })[0];
  assert.ok(short, 'a short drop to keep');
  assert.strictEqual(registry.get('cable', short.cable).fiberCount, 1, 'a short PON drop stays 1F drop cable');

  // But the drop is still one route, not a trunk: no bundle is invented for it.
  assert.strictEqual(long[0].bundles === undefined ? 1 : long[0].bundles, 1);
});

test('a home-run cable comes from the callers ladder, not a hard-coded model', function () {
  // `cableForSpan` is the one place the drop/ladder rule lives. The home-run builder used to restate
  // it as `lengthM > 300 ? 'g652d-loose-12' : ...`, which ignored `ladder`: a caller whose ladder has
  // no 12-fibre cable got a model it never listed, priced from a catalogue entry it excluded.
  const ladder = ['g652d-loose-24'];
  const out = engine.design.synthesise([
    { label: 'Near', lat: 51.5000, lon: -0.1 },
    { label: 'Far', lat: 51.5108, lon: -0.1 }
  ], { headEnd: { lat: 51.4995, lon: -0.1 }, technology: 'active', ladder: ladder, includeAllPlants: true }, registry);
  const home = out.candidates.filter(function (c) { return c.technology === 'active-home-run'; })[0];
  assert.ok(home, 'a home-run candidate');
  const long = home.plant.spans.filter(function (s) { return s.lengthM > engine.design.DROP_CABLE_MAX_M; });
  assert.ok(long.length > 0, 'a long home-run span to check');
  for (const span of long) {
    assert.strictEqual(span.cable, 'g652d-loose-24', span.id + ' is ' + span.lengthM + ' m on ' + span.cable);
  }
});

test('the runs carry a purpose, a cable and a positive length', function () {
  const out = engine.design.synthesise(street(10, 0.0004), { headEnd: HEAD_END }, registry);
  assert.ok(out.runs.length > 0);
  for (const run of out.runs) {
    assert.ok(run.lengthM > 0, JSON.stringify(run));
    assert.ok(registry.has('cable', run.cable), run.cable);
    assert.ok(['feeder', 'distribution', 'drop', 'tree', 'home-run', 'splitter-tail'].indexOf(run.purpose) !== -1, run.purpose);
  }
  if (out.technology === 'pon') {
    const purposes = new Set(out.runs.map(function (r) { return r.purpose; }));
    assert.ok(purposes.has('feeder') && purposes.has('distribution'));
  }
});

test('a PON feeder does not cascade splitters that sit side by side', function () {
  const out = engine.design.synthesise(street(40, 0.00045), {
    headEnd: HEAD_END,
    technology: 'pon',
    pon: { ratios: [8] }
  }, registry);
  assert.strictEqual(out.ok, true, JSON.stringify(out.notes));
  const budgets = engine.network.allOntBudgets(out.plant, registry);
  for (const entry of budgets) {
    // One splitter per path: the cascade is 1:8, never 1:8^sites.
    assert.strictEqual(entry.result.cascadeRatio, 8, entry.ont + ' cascade ' + entry.result.cascadeRatio);
  }
});

test('cable is tapered, and a long span is never a drop cable', function () {
  // This call passes no ladder option, so every pick below comes from DEFAULT_LADDER.
  const ladder = engine.design.DEFAULTS.ladder;
  const out = engine.design.synthesise(street(20, 0.0005), { headEnd: HEAD_END, technology: 'active' }, registry);
  for (const span of out.plant.spans) {
    const cable = registry.get('cable', span.cable);
    const required = span.strands ? span.strands.length : 1;
    assert.ok(cable.fiberCount >= required, span.id + ' uses ' + cable.model + ' for ' + required + ' fibres');
    if (span.lengthM > engine.design.DROP_CABLE_MAX_M) {
      // A 1.2 km two-fibre run is a cable run, not a drop: drop cable is not what gets pulled there.
      // A `drop` over the same limit is the same mistake, so it is held to the same floor (this test
      // used to exempt drops, which let the exception hide a 400 m spur on 1-fibre cable).
      assert.ok(cable.fiberCount >= 12, span.id + ' is ' + span.lengthM + ' m on ' + cable.model);
    } else {
      // The pick is cableFor(required, ladder, registry) - the smallest RUNG of the caller's ladder
      // that fits, never the smallest cable in the catalogue. This filter used the whole catalogue,
      // which passed only while no rung existed inside a band an ordinary design spans. The aerial
      // 36F row put one at 25-36 fibres, and a 32-strand short span on DEFAULT_LADDER buys
      // g652d-loose-48 while g652d-adss-36 fits. Whether the default should name a 36F rung is gh#155,
      // the open default-ladder question, so the guard is scoped to the ladder the design was given
      // and the non-minimality it used to expose is pinned by the test below instead of being lost.
      const smaller = registry.all('cable').filter(function (c) {
        return ladder.indexOf(c.model) !== -1 &&
          c.fiberCount >= required && c.fiberCount < cable.fiberCount && c.fiberCount >= 12;
      });
      assert.strictEqual(smaller.length, 0, span.id + ' could have used a smaller cable than ' + cable.model);
    }
  }
});

test('the default ladder names no aerial 36F rung, so 32 strands are bought as 48F', function () {
  // Named rather than hidden. The catalogue carries a 36F aerial rung and DEFAULT_LADDER lists no
  // aerial row at all, so a 25-36 fibre span is bought as g652d-loose-48 until a default-ladder
  // decision names the smaller rung - the same open question as g657a2-drop-4 (gh#155). This pins
  // today's answer so that decision is a visible change and not a silent re-ranking.
  assert.strictEqual(engine.design.cableForSpan(32, 120, engine.design.DEFAULTS.ladder, registry).model, 'g652d-loose-48');
  assert.strictEqual(engine.design.cableForSpan(32, 1200, engine.design.DEFAULTS.ladder, registry).model, 'g652d-loose-48');
  assert.strictEqual(engine.design.DEFAULT_LADDER.indexOf('g652d-adss-36'), -1, 'not a default rung');
  assert.strictEqual(engine.design.DEFAULT_LADDER.indexOf('g652d-adss-60'), -1, 'not a default rung');
});

test('a cost model changes the objective, and the output says which one it used', function () {
  const demand = street(10, 0.0004);
  const byFibre = engine.design.synthesise(demand, { headEnd: HEAD_END }, registry);
  assert.strictEqual(byFibre.objective, 'fibre-metres');
  const byCost = engine.design.synthesise(demand, {
    headEnd: HEAD_END,
    costs: { splice: 8, closure: 120, splitter: 40, cablePerM: { 'g652d-loose-12': 1.1, 'g652d-loose-24': 2.0, 'g657a2-drop-1': 0.4, 'g657a2-drop-2': 0.6 } }
  }, registry);
  assert.strictEqual(byCost.objective, 'cost');
  assert.ok(byCost.best.metrics.cost > 0);
});

test('the design BOM buys each cable on its own drum length, rounded once', function () {
  const out = engine.design.synthesise(street(30, 0.0008), { headEnd: HEAD_END }, registry);
  const candidate = out.candidates.filter(function (c) { return c.feasible; })[0];
  assert.ok(candidate, 'a feasible candidate');
  assert.ok(candidate.bom.lines.length > 0, 'the winner has a cable to buy');
  let sawShortDrum = false;
  for (const line of candidate.bom.lines) {
    const part = registry.get('cable', line.model);
    // The drum length is a property of the cable: 1-fibre drop cable ships on a 1 km drum. The design
    // BOM used to hardcode 2 km for every model, so 915 m of drop was bought as 2000 m - a drum of a
    // product this cable is not sold on - and a 2500 m run would have been bought as 4000 m.
    assert.strictEqual(line.drumM, part.drumM, line.model + ' drum length');
    const drums = Math.ceil(line.designM / part.drumM);
    assert.strictEqual(line.drums, drums, line.model + ' drums for ' + line.designM + ' m');
    assert.strictEqual(line.purchaseM, drums * part.drumM, line.model + ' purchased metres');
    if (part.drumM !== 2000) sawShortDrum = true;
  }
  assert.ok(sawShortDrum, 'the winner carries a cable whose drum is not 2 km, or this test proves nothing');
});

test('a cost model that leaves a cable unpriced is refused, naming the model', function () {
  // A price list that covers the PON feeder and the 1-fibre drop but not the 2-fibre drop or the
  // 24-fibre trunk is not a money model: charging the missing cables 0 makes a design that builds
  // with them look free, and the ranking is then wrong in the one direction nobody checks. The
  // engine used to do exactly that (`isNum(perM) ? perM : 0`), so this asserts the refusal instead.
  const err = throws(function () {
    engine.design.synthesise(street(10, 0.0004), {
      headEnd: HEAD_END,
      costs: { splice: 8, closure: 120, splitter: 40, cablePerM: { 'g652d-loose-12': 1.1, 'g657a2-drop-1': 0.4 } }
    }, registry);
  }, 'costs.cablePerM has no price for', 'synthesise with a partial price list');
  assert.ok(err.message.indexOf('g652d-loose-24') !== -1, 'names the 24-fibre trunk: ' + err.message);
  assert.ok(err.message.indexOf('g657a2-drop-2') !== -1, 'names the 2-fibre drop: ' + err.message);
});

test('a cost model with no cable price at all is refused', function () {
  // Splice and closure prices alone rank on the small terms and ignore the term cable price tracks
  // (fibre-metres) - the objective would say "cost" and mean "splices". Refused rather than ignored.
  throws(function () {
    engine.design.synthesise(street(4, 0.0004), { headEnd: HEAD_END, costs: { splice: 8 } }, registry);
  }, 'costs.cablePerM is required', 'synthesise with no cablePerM');
});

test('a negative cable price is refused, not netted off the BOM', function () {
  throws(function () {
    engine.design.synthesise(street(4, 0.0004), {
      headEnd: HEAD_END,
      costs: { cablePerM: { 'g652d-loose-12': -1 } }
    }, registry);
  }, 'costs.cablePerM["g652d-loose-12"] must be a non-negative number', 'synthesise with a negative price');
});
