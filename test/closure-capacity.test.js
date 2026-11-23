'use strict';
// A closure's splice capacity is a fact about the box, so the warning must count the splices the
// box holds - one per strand of the cable that passes through it - and not the splices on the path
// that happens to run through it. The two numbers happen to agree at the first closure on a route
// and diverge at every one after it, which is why a cumulative counter looked right for months:
// on a feeder with thirteen handholes the thirteenth was reported as holding thirteen splices when
// it holds twelve, and a technician was told to open a box that was full when it sat at capacity.
const { test, assert, close, done } = require('./harness');
const engine = require('../engine');

const registry = engine.createRegistry();
const network = engine.network;

/** A feeder of `handholes` handholes on `cable`, closed by one drop to a single ONT. */
function feeder(handholes, cable, dropCable) {
  const nodes = [{ id: 'olt1', type: 'olt', model: 'gpon-c-plus-8', name: 'OLT' }];
  const spans = [];
  let prev = 'olt1';
  for (let i = 1; i <= handholes; i++) {
    nodes.push({ id: 'hh' + i, type: 'closure', model: 'handhole-4', name: 'Handhole ' + i });
    spans.push({ id: 's' + i, from: prev, to: 'hh' + i, cable: cable, lengthM: 30 });
    prev = 'hh' + i;
  }
  nodes.push({ id: 'ont1', type: 'ont', model: 'gpon-ont-1ge', name: 'Casa 1' });
  spans.push({ id: 'sd', from: prev, to: 'ont1', cable: dropCable || 'g657a2-drop-1', lengthM: 40 });
  return { name: 'Feeder', nodes: nodes, spans: spans };
}

test('thirteen handholes on a 12-fibre feeder are all at capacity, not over it', function () {
  // Each handhole splices the 12 strands of the cable through it: 12 splices, capacity 12. A path
  // counter would say the thirteenth holds 13.
  const r = network.designForOnt(feeder(13, 'g652d-loose-12'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

test('a 48-fibre cable dragged through a 12-splice handhole is named, with its own count', function () {
  // handhole-4 carries 12 splices; 48 strands through it is 48 splices, four times its capacity.
  // Both mid-path boxes are over-stuffed and both are named; the tail box holds the drop splice
  // alone, so it is not.
  const r = network.designForOnt(feeder(3, 'g652d-loose-48'), 'ont1', registry);
  assert.strictEqual(r.notes.length, 2, 'one note per over-stuffed box: ' + JSON.stringify(r.notes));
  for (const note of r.notes) {
    assert.ok(note.indexOf('48 splices') !== -1, 'counts the splices in the box: ' + note);
    assert.ok(note.indexOf('capacity 12') !== -1, 'states the capacity: ' + note);
    assert.ok(note.indexOf('"Handhole 3"') === -1, 'the tail box holds one splice, not 48: ' + note);
  }
  assert.ok(r.notes[0].indexOf('"Handhole 1"') !== -1, 'names the first box: ' + r.notes[0]);
  assert.ok(r.notes[1].indexOf('"Handhole 2"') !== -1, 'names the second box: ' + r.notes[1]);
});

test('the tail closure holds the drop splice, not the feeder it is fed from', function () {
  // The last box splices the 12 strands through and terminates 1 drop strand, so what it holds is
  // the smaller cable: one splice. Counting the largest cable touching it would call this twelve.
  const r = network.designForOnt(feeder(1, 'g652d-loose-12'), 'ont1', registry);
  assert.deepStrictEqual(r.notes, []);
});

test('the capacity warning does not change the loss on the strand path', function () {
  // A strand meets one splice per closure however many fibres share the cable, so 13 handholes add
  // 13 x 0.1 = 1.3 dB. The capacity fix is a report about the box and must stay out of the budget.
  const r = network.designForOnt(feeder(13, 'g652d-loose-12'), 'ont1', registry);
  const splice = r.breakdown.filter(function (b) { return b.kind === 'splice'; });
  assert.strictEqual(splice.length, 1, 'one splice line');
  close(splice[0].db, 1.3, 0.001, '13 through-splices at 0.1 dB');
});

done();
