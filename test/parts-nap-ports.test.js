'use strict';
// A NAP's `ports` is the number of CABLES the box takes, not the number of drop adapters it presents.
// engine/network.js warns when the spans touching a closure outnumber its `ports`, and a street box
// cannot be fed by nothing: the catalogue wrote the drop-adapter count (8, 16) into the field the
// engine counts cables with, so a NAP loaded with exactly the drops it is sold for, plus the feeder
// that reaches it, was reported as over-ported - the row said the designer had bought the wrong box
// on the very plant that box exists for. CommScope's SSC2811-SM-8 publishes the split explicitly:
// "Distribution capacity 1(Input) + 8(Drop)", one inlet adapter plus eight outlet adapters, and
// Prysmian's MTWB lists 16 drop ports against "No. of Input cable ports 1 top and 1 bottom". Drop
// ports and cable entries are two counts, and the engine reads the second.
const { test, assert, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

/** One feeder into a closure, then `drops` single-fibre drop cables out to as many ONTs. */
function load(model, drops) {
  const nodes = [
    { id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' },
    { id: 'n1', type: 'closure', model: model, name: 'NAP' }
  ];
  const spans = [{ id: 's0', from: 'olt1', to: 'n1', cable: 'g652d-loose-12', lengthM: 300 }];
  for (let i = 1; i <= drops; i++) {
    nodes.push({ id: 'ont' + i, type: 'ont', model: 'gpon-ont-1ge', name: 'Casa ' + i });
    spans.push({ id: 'sd' + i, from: 'n1', to: 'ont' + i, cable: 'g657a2-drop-1', lengthM: 40 });
  }
  return { name: 'NAP load', nodes: nodes, spans: spans };
}

function portWarnings(plant) {
  return network.validate(plant, registry).warnings.filter(function (w) {
    return w.indexOf('cables into') !== -1;
  });
}

test('a NAP loaded with its eight drops and the feeder that feeds it is not over-ported', function () {
  // 8 drops + 1 feeder = 9 cables into the box; nap-8 publishes 8 drop adapters + 1 feeder entry = 9.
  assert.deepStrictEqual(portWarnings(load('nap-8', 8)), []);
});

test('the ninth drop on an 8-port NAP is named, with both numbers', function () {
  // 9 drops + 1 feeder = 10 cables into 9 ports: one drop more than the box terminates.
  const w = portWarnings(load('nap-8', 9));
  assert.strictEqual(w.length, 1, 'one port warning: ' + JSON.stringify(w));
  assert.ok(w[0].indexOf('10 cables into 9 ports') !== -1, 'counts cables and states ports: ' + w[0]);
});

test('the 16-port NAP takes sixteen drops and its feeder', function () {
  // 16 + 1 = 17 cables; 16 drop adapters + 1 feeder entry = 17 ports.
  assert.deepStrictEqual(portWarnings(load('nap-16', 16)), []);
  const w = portWarnings(load('nap-16', 17));
  assert.strictEqual(w.length, 1, '18 cables into 17 ports: ' + JSON.stringify(w));
  assert.ok(w[0].indexOf('18 cables into 17 ports') !== -1, w[0]);
});

test('the 16-port splitter box takes sixteen drops and its feeder', function () {
  assert.deepStrictEqual(portWarnings(load('splitter-box-16', 16)), []);
});

test('a daisy-chained NAP is the box that publishes a cascade port, not the end box', function () {
  // CommScope's cascade variant (SSC2811-SM-9U) publishes 1(Input) + 1(Extension) + 8(Drop) = 10.
  // The end-box row must not claim that port, or a two-feeder NAP passes a check it should fail.
  assert.strictEqual(registry.get('closure', 'nap-8').ports, 9, '1 feeder + 8 drops, no extension port');
  assert.ok(registry.get('closure', 'nap-16').ports >= 10, 'nap-16 holds 8 drops + 2 feeder entries');
});

test('the feeder entry is the port the old figure was missing, on every drop-side box', function () {
  // Each row's ports must exceed its drop adapters by the entry the feeder comes in through; before
  // this suite all three published the adapter count itself.
  const rows = [['nap-8', 8], ['nap-16', 16], ['splitter-box-16', 16]];
  for (const pair of rows) {
    const row = registry.get('closure', pair[0]);
    assert.strictEqual(row.ports, pair[1] + 1, pair[0] + ': ' + pair[1] + ' drop ports + 1 feeder entry');
  }
});

done();
