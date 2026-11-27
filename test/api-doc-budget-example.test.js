'use strict';
// The worked example in docs/API.md is a budget, not an illustration: it quotes the exact figures
// `/api/projects/:id/budget` answers for one project. Nothing was checking it, and it rotted - it
// still promised `headroomDb` 21.14 from a -30 dBm receiver and a +3 dBm launch for an example whose
// ONT (`gpon-ont-1ge`) is -27 dBm and whose default launch is the transmitter's minimum, 1.5 dBm, so
// the sentence was 4.5 dB optimistic against the 16.64 the endpoint answers. The engine never reads
// the doc, and an example that names no ONT cannot be reproduced by a reader at all. This suite is
// that reader: it parses the fence in the paragraph and re-drives every row.
const fs = require('fs');
const path = require('path');
const { test, assert, done } = require('./harness');
const parts = require('../engine/parts');
const network = require('../engine/network');

const registry = parts.createRegistry();
const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'API.md'), 'utf8');

/** The documented plant, exactly as the paragraph names it. */
function documentedPlant() {
  return {
    name: 'worked example',
    nodes: [
      { id: 'n1', type: 'olt', model: 'gpon-b-plus-8', name: 'OLT' },
      { id: 'n2', type: 'splitter', model: 'plc-1x8-sca', name: 'S1' },
      { id: 'n3', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' }
    ],
    spans: [
      { id: 's1', from: 'n1', to: 'n2', cable: 'g652d-loose-12', lengthM: 3000 },
      { id: 's2', from: 'n2', to: 'n3', cable: 'g657a2-drop-1', lengthM: 1 }
    ]
  };
}

/**
 * The fenced rows under the paragraph that names this suite. Each line is `{options}`, then
 * `key value` pairs two or more spaces apart - the spacing is what makes the block readable and
 * parseable at once. A dotted key (`attenuator.padDb`) walks into the result.
 */
function documentedRows() {
  const marker = doc.indexOf('test/api-doc-budget-example.test.js');
  assert.ok(marker !== -1, 'docs/API.md no longer names this suite - the paragraph quoting the figures is gone');
  const open = doc.indexOf('```', marker);
  const close = doc.indexOf('```', open + 3);
  assert.ok(open !== -1 && close !== -1, 'docs/API.md: the worked-example fence is missing or unterminated');
  return doc.slice(open + 3, close).trim().split(/\r?\n/).map(function (line) {
    return line.trim().split(/\s{2,}/);
  });
}

function valueAt(result, key) {
  return key.split('.').reduce(function (v, part) {
    return v === null || v === undefined ? v : v[part];
  }, result);
}

test('the budget worked example in docs/API.md is what the engine answers', function () {
  const rows = documentedRows();
  assert.strictEqual(rows.length, 5, 'the worked example carries the default, the allowance, both model knobs and the too-loud launch');
  const plant = documentedPlant();
  // A model renamed in the catalogue has to be renamed in the example with it, so the documented
  // plant is validated first: an example naming a model that does not exist cannot be run at all.
  const checked = network.validate(plant, registry);
  assert.deepStrictEqual(checked.errors, [], 'the documented plant must validate: ' + checked.errors.join('; '));

  let sawFail = false;
  rows.forEach(function (fields) {
    const options = JSON.parse(fields[0]);
    const label = fields[0];
    const pairs = fields.slice(1).map(function (field) {
      const cut = field.indexOf(' ');
      assert.ok(cut > 0, 'row "' + label + '": "' + field + '" is not a key and a value');
      return [field.slice(0, cut), field.slice(cut + 1).trim()];
    });
    const row = network.allOntBudgets(plant, registry, options)[0];
    assert.ok(row.result, 'row "' + label + '" must budget, got: ' + row.error);
    pairs.forEach(function (pair) {
      const key = pair[0];
      const quoted = pair[1];
      const actual = valueAt(row.result, key);
      if (key === 'verdict') {
        assert.strictEqual(actual, quoted, 'row "' + label + '": verdict');
        if (quoted === 'fail') sawFail = true;
      } else if (quoted === 'null') {
        assert.strictEqual(actual, null, 'row "' + label + '": ' + key + ' should be null');
      } else {
        assert.ok(typeof actual === 'number', 'row "' + label + '": ' + key + ' is not a number in the result');
        // Every engine figure is rounded to 2 dp; the tolerance is for binary floating point, not
        // for a correction. A part that moves a loss has to move the doc, not fit inside a band.
        assert.ok(Math.abs(actual - Number(quoted)) < 1e-9,
          'row "' + label + '": ' + key + ' is ' + actual + ' in the engine, ' + quoted + ' in docs/API.md');
      }
    });
  });
  assert.ok(sawFail, 'the example should still carry the too-loud row - verdict fail, attenuator.padDb 4');
});

done();
