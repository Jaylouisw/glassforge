'use strict';
// Claims the catalogue makes about itself, checked instead of hoped for. Both are the reason a row
// exists at all, and both were prose in a note: lc-upc says every transceiver here is UPC and that no
// UPC LC row existed before it; every ONT row assumes a line card of its PON exists. A claim in `notes`
// rots the moment a part is added, so the two that can be checked are checked here.
const { test, assert, done } = require('./harness');
const parts = require('../engine/parts');

const registry = parts.createRegistry();

test("every polish a transceiver declares has a connector row to mate it", function () {
  // The bug lc-upc was added for: every optic was UPC while the connector family only carried LC/APC,
  // so an active link had to be budgeted with a mating that cannot plug into its own optic.
  const optics = registry.all('transceiver');
  assert.ok(optics.length > 0, 'no transceivers to check - the suite would pass on an empty catalogue');
  for (const optic of optics) {
    assert.ok(optic.polish, optic.model + ' declares no polish, so its mating cannot be checked');
    const rows = registry.all('connector').filter(function (c) { return c.polish === optic.polish; });
    assert.ok(rows.length > 0,
      optic.model + ' is ' + optic.polish + ', and no connector row is: a project cannot budget its patch cords');
  }
});

test("an ONT's PON has a line card in the catalogue", function () {
  // An ONT of a PON with no OLT row is unbuildable: the PON port it needs is not in the catalogue, and
  // auto-design skips every candidate that names it.
  const onts = registry.all('ont');
  assert.ok(onts.length > 0, 'no ONTs to check');
  for (const ont of onts) {
    const cards = registry.all('olt').filter(function (o) { return o.pon === ont.pon; });
    assert.ok(cards.length > 0, ont.model + ' is a ' + ont.pon + ' ONT and the catalogue has no ' + ont.pon + ' OLT');
  }
});

done();
