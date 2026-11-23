'use strict';
/**
 * Glassforge engine — pure functions over a fibre plant.
 *
 * No HTTP, no disk, no clock, no dependency. `server/` is the only thing that knows about ports and
 * files, which is what lets the whole planning model be exercised by a test in milliseconds.
 */

const fiber = require('./fiber');
const geo = require('./geo');
const parts = require('./parts');
const budget = require('./budget');
const length = require('./length');
const network = require('./network');
const kml = require('./kml');
const project = require('./project');
const demand = require('./demand');
const design = require('./design');
const street = require('./street');
const link = require('./link');

module.exports = {
  fiber: fiber,
  geo: geo,
  parts: parts,
  budget: budget,
  length: length,
  network: network,
  kml: kml,
  project: project,
  demand: demand,
  design: design,
  street: street,
  link: link,
  createRegistry: parts.createRegistry,
  version: require('../package.json').version
};
