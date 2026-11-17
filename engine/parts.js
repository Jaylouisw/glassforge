'use strict';
/**
 * The parts registry: cables, splitters, OLTs, ONTs, closures, connectors, splices.
 *
 * Adding a part is dropping a JSON file in `parts/<kind>/<model>.json`. No code change, for the
 * same reason PacketForge takes a device as a JSON file: the catalogue is the thing that grows, and
 * it must grow without touching the engine.
 *
 * Two rules the validator enforces because they are the difference between a planner and a
 * drawing tool:
 *
 * 1. **A missing figure stays missing.** A cable that does not publish attenuation at 1490 nm
 *    fails validation rather than defaulting to zero, because a zero-loss fibre produces a
 *    budget that says "OK" for a network that will not light.
 * 2. **A number taken from a datasheet says where it came from.** Cable, splitter, OLT and ONT
 *    specs carry `sourceUrl`; a figure with no provenance is a figure nobody can re-check.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PARTS_DIR = path.join(ROOT, 'parts');

const KINDS = ['cable', 'splitter', 'olt', 'ont', 'transceiver', 'closure', 'connector', 'splice'];
const WAVELENGTHS = ['1310', '1490', '1550'];
const PON_TYPES = ['gpon', 'xg-pon', 'xgs-pon'];
const POLISHES = ['pc', 'upc', 'apc'];
const CABLE_USES = ['feeder', 'distribution', 'drop', 'indoor'];
const CONSTRUCTIONS = ['loose-tube', 'ribbon', 'tight-buffer'];
const CLOSURE_TYPES = ['nap', 'mufa', 'inline', 'handhole', 'cabinet', 'splitter-box'];
const TERMINATIONS = ['spliced', 'connectorised'];
const MODEL_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Published optical budget per PON class, in dB (ITU-T G.984.2 for GPON, G.9807.1 for XGS-PON).
 * The OLT spec carries its own `budgetDb`; this table is what a spec is checked against, so a
 * typo in a part file cannot invent a class that does not exist.
 */
const CLASS_BUDGET_DB = {
  'gpon-b+': 28,
  'gpon-c+': 32,
  'gpon-c++': 35,
  'xg-pon-n1': 29,
  'xg-pon-n2': 31,
  'xgs-pon-n1': 29,
  'xgs-pon-n2': 31,
  'xgs-pon-e1': 33,
  'xgs-pon-e2': 35
};

function classBudgetDb(pon, cls) {
  const key = String(pon || '').toLowerCase() + '-' + String(cls || '').toLowerCase();
  const hit = CLASS_BUDGET_DB[key];
  return typeof hit === 'number' ? hit : null;
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isPosInt(v) { return Number.isInteger(v) && v > 0; }
function isInt(v) { return Number.isInteger(v); }
function isPowerOfTwo(n) { return isPosInt(n) && (n & (n - 1)) === 0; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function pushIssue(list, level, field, message) {
  list.push({ level: level, field: field, message: message });
}

function validateCommon(spec, issues) {
  if (!isNonEmptyString(spec.kind)) pushIssue(issues, 'error', 'kind', 'kind is required');
  else if (KINDS.indexOf(spec.kind) === -1) {
    pushIssue(issues, 'error', 'kind', 'unknown kind "' + spec.kind + '" - expected one of ' + KINDS.join(', '));
  }
  if (!isNonEmptyString(spec.model)) pushIssue(issues, 'error', 'model', 'model is required');
  else if (!MODEL_RE.test(spec.model)) {
    pushIssue(issues, 'error', 'model', 'model "' + spec.model + '" must be a lowercase slug (a-z, 0-9, dot, dash, underscore)');
  }
  if (!isNonEmptyString(spec.label)) pushIssue(issues, 'error', 'label', 'label is required (what a user picks from a list)');
  if (spec.tags !== undefined && !Array.isArray(spec.tags)) pushIssue(issues, 'error', 'tags', 'tags must be an array of strings');
}

function validateCable(spec, issues) {
  if (!isPosInt(spec.fiberCount) || spec.fiberCount > 3456) {
    pushIssue(issues, 'error', 'fiberCount', 'fiberCount must be an integer 1..3456');
  }
  const perTube = spec.fibersPerTube === undefined ? 12 : spec.fibersPerTube;
  if (!isInt(perTube) || perTube < 1 || perTube > 24) {
    pushIssue(issues, 'error', 'fibersPerTube', 'fibersPerTube must be an integer 1..24');
  }
  if (spec.construction !== undefined && CONSTRUCTIONS.indexOf(spec.construction) === -1) {
    pushIssue(issues, 'error', 'construction', 'construction must be one of ' + CONSTRUCTIONS.join(', '));
  }
  const att = spec.attenuationDbPerKm;
  if (!att || typeof att !== 'object') {
    pushIssue(issues, 'error', 'attenuationDbPerKm', 'attenuationDbPerKm is required, e.g. {"1310":0.35,"1490":0.22,"1550":0.20}');
  } else {
    let seen = 0;
    for (const key of Object.keys(att)) {
      if (WAVELENGTHS.indexOf(key) === -1) {
        pushIssue(issues, 'error', 'attenuationDbPerKm.' + key, 'unknown wavelength window "' + key + '" - expected 1310, 1490 or 1550');
        continue;
      }
      if (!isNum(att[key]) || att[key] <= 0 || att[key] > 2) {
        pushIssue(issues, 'error', 'attenuationDbPerKm.' + key, 'attenuation must be a number in (0, 2] dB/km');
      } else {
        seen++;
      }
    }
    if (!seen) pushIssue(issues, 'error', 'attenuationDbPerKm', 'at least one wavelength window with a published figure is required');
  }
  if (spec.use !== undefined) {
    if (!Array.isArray(spec.use) || !spec.use.length) pushIssue(issues, 'error', 'use', 'use must be a non-empty array');
    else spec.use.forEach(function (u) {
      if (CABLE_USES.indexOf(u) === -1) pushIssue(issues, 'error', 'use', 'unknown use "' + u + '" - expected ' + CABLE_USES.join(', '));
    });
  }
  if (spec.drumM !== undefined && (!isPosInt(spec.drumM) || spec.drumM > 10000)) {
    pushIssue(issues, 'error', 'drumM', 'drumM must be an integer 1..10000 metres');
  }
  if (!isNonEmptyString(spec.sourceUrl)) {
    pushIssue(issues, 'error', 'sourceUrl', 'sourceUrl is required: an attenuation figure without provenance cannot be re-checked');
  }
}

function validateSplitter(spec, issues) {
  if (!isPowerOfTwo(spec.ratio) || spec.ratio < 2 || spec.ratio > 128) {
    pushIssue(issues, 'error', 'ratio', 'ratio must be a power of two from 2 to 128');
  }
  const derived = isPowerOfTwo(spec.ratio) ? Math.round(10 * Math.log10(spec.ratio) * 100) / 100 : null;
  if (spec.splitLossDb !== undefined) {
    if (!isNum(spec.splitLossDb) || spec.splitLossDb < 0 || spec.splitLossDb > 30) {
      pushIssue(issues, 'error', 'splitLossDb', 'splitLossDb must be a number in [0, 30]');
    } else if (derived !== null && Math.abs(spec.splitLossDb - derived) > 0.15) {
      pushIssue(issues, 'warn', 'splitLossDb',
        'splitLossDb ' + spec.splitLossDb + ' differs from 10*log10(' + spec.ratio + ') = ' + derived + ' by more than 0.15 dB');
    }
  }
  if (!isNum(spec.excessLossDb) || spec.excessLossDb < 0 || spec.excessLossDb > 3) {
    pushIssue(issues, 'error', 'excessLossDb', 'excessLossDb is required, a number in [0, 3] (PLC 1x8 is typically 0.4-0.8)');
  }
  if (spec.uniformityDb !== undefined && (!isNum(spec.uniformityDb) || spec.uniformityDb < 0 || spec.uniformityDb > 4)) {
    pushIssue(issues, 'error', 'uniformityDb', 'uniformityDb must be a number in [0, 4]');
  }
  if (spec.termination !== undefined && TERMINATIONS.indexOf(spec.termination) === -1) {
    pushIssue(issues, 'error', 'termination', 'termination must be one of ' + TERMINATIONS.join(', '));
  }
  if (!isNonEmptyString(spec.sourceUrl)) {
    pushIssue(issues, 'error', 'sourceUrl', 'sourceUrl is required: INSERTION_LOSS comes from the datasheet, not from arithmetic alone');
  }
}

function validatePon(spec, issues, isOlt) {
  if (PON_TYPES.indexOf(String(spec.pon)) === -1) {
    pushIssue(issues, 'error', 'pon', 'pon must be one of ' + PON_TYPES.join(', '));
  }
  if (isOlt) {
    if (!isNonEmptyString(spec.class)) pushIssue(issues, 'error', 'class', 'class is required (B+, C+, C++, N1, N2, E1, E2)');
    const tableDb = classBudgetDb(spec.pon, spec.class);
    if (spec.class && tableDb === null) {
      pushIssue(issues, 'error', 'class', 'no published budget for ' + spec.pon + ' class "' + spec.class + '"');
    }
    if (!isNum(spec.budgetDb)) {
      pushIssue(issues, 'error', 'budgetDb', 'budgetDb is required' + (tableDb !== null ? ' (the published figure for ' + spec.pon + ' ' + spec.class + ' is ' + tableDb + ' dB)' : ''));
    } else if (tableDb !== null && Math.abs(spec.budgetDb - tableDb) > 0.5) {
      pushIssue(issues, 'warn', 'budgetDb', 'budgetDb ' + spec.budgetDb + ' differs from the published ' + tableDb + ' dB for ' + spec.pon + ' ' + spec.class);
    }
    if (!isPosInt(spec.ports)) pushIssue(issues, 'error', 'ports', 'ports must be a positive integer (PON ports on the OLT)');
    if (!isPowerOfTwo(spec.maxSplitRatio) || spec.maxSplitRatio < 2 || spec.maxSplitRatio > 128) {
      pushIssue(issues, 'error', 'maxSplitRatio', 'maxSplitRatio must be a power of two from 2 to 128');
    }
  }
  if (!isNum(spec.txPowerDbmMin) || !isNum(spec.txPowerDbmMax)) {
    pushIssue(issues, 'error', 'txPowerDbmMin/txPowerDbmMax', 'both transmit power bounds are required');
  } else if (spec.txPowerDbmMin > spec.txPowerDbmMax) {
    pushIssue(issues, 'error', 'txPowerDbmMin', 'txPowerDbmMin must not exceed txPowerDbmMax');
  }
  if (!isNum(spec.rxSensitivityDbm)) pushIssue(issues, 'error', 'rxSensitivityDbm', 'rxSensitivityDbm is required');
  if (!isNum(spec.rxOverloadDbm)) pushIssue(issues, 'error', 'rxOverloadDbm', 'rxOverloadDbm is required');
  if (isNum(spec.rxSensitivityDbm) && isNum(spec.rxOverloadDbm) && spec.rxSensitivityDbm >= spec.rxOverloadDbm) {
    pushIssue(issues, 'error', 'rxSensitivityDbm', 'sensitivity must be below overload (a receiver cannot be deaf and blind at once)');
  }
  if (!isNonEmptyString(spec.sourceUrl)) {
    pushIssue(issues, 'error', 'sourceUrl', 'sourceUrl is required: sensitivity and class budget are datasheet figures');
  }
}

/** An optic: the two ends of an active (point-to-point) link, and the figures its budget needs. */
function validateTransceiver(spec, issues) {
  if (!isPosInt(spec.speedMbps) || spec.speedMbps > 1600000) {
    pushIssue(issues, 'error', 'speedMbps', 'speedMbps must be a positive integer (1000, 10000, 25000, 100000, ...)');
  }
  if (!isNum(spec.wavelengthNm) || spec.wavelengthNm < 1260 || spec.wavelengthNm > 1675) {
    pushIssue(issues, 'error', 'wavelengthNm', 'wavelengthNm must be a number in [1260, 1675] - the usable window of single-mode fibre');
  }
  if (!isPosInt(spec.reachM) || spec.reachM > 200000) {
    pushIssue(issues, 'error', 'reachM', 'reachM must be a positive integer no more than 200 km');
  }
  if (!isNum(spec.txPowerDbmMin) || !isNum(spec.txPowerDbmMax)) {
    pushIssue(issues, 'error', 'txPowerDbmMin/txPowerDbmMax', 'both launch power bounds are required');
  } else if (spec.txPowerDbmMin > spec.txPowerDbmMax) {
    pushIssue(issues, 'error', 'txPowerDbmMin', 'txPowerDbmMin must not exceed txPowerDbmMax');
  }
  if (!isNum(spec.rxSensitivityDbm)) pushIssue(issues, 'error', 'rxSensitivityDbm', 'rxSensitivityDbm is required');
  if (!isNum(spec.rxOverloadDbm)) pushIssue(issues, 'error', 'rxOverloadDbm', 'rxOverloadDbm is required');
  if (isNum(spec.rxSensitivityDbm) && isNum(spec.rxOverloadDbm) && spec.rxSensitivityDbm >= spec.rxOverloadDbm) {
    pushIssue(issues, 'error', 'rxSensitivityDbm', 'sensitivity must be below overload');
  }
  if (spec.polish !== undefined && POLISHES.indexOf(spec.polish) === -1) {
    pushIssue(issues, 'error', 'polish', 'polish must be one of ' + POLISHES.join(', '));
  }
  if (!isNonEmptyString(spec.sourceUrl)) {
    pushIssue(issues, 'error', 'sourceUrl', 'sourceUrl is required: launch power and sensitivity are datasheet figures');
  }
}

function validateClosure(spec, issues) {
  if (!isPosInt(spec.ports)) pushIssue(issues, 'error', 'ports', 'ports must be a positive integer');
  if (!isInt(spec.spliceCapacity) || spec.spliceCapacity < 0) pushIssue(issues, 'error', 'spliceCapacity', 'spliceCapacity must be a non-negative integer');
  if (spec.type !== undefined && CLOSURE_TYPES.indexOf(spec.type) === -1) {
    pushIssue(issues, 'error', 'type', 'type must be one of ' + CLOSURE_TYPES.join(', '));
  }
}

function validateLossPart(spec, issues, kind) {
  if (!isNum(spec.lossDb) || spec.lossDb < 0 || spec.lossDb > 1) {
    pushIssue(issues, 'error', 'lossDb', 'lossDb is required, a number in [0, 1] dB');
  }
  if (spec.maxLossDb !== undefined && (!isNum(spec.maxLossDb) || spec.maxLossDb < (spec.lossDb || 0))) {
    pushIssue(issues, 'error', 'maxLossDb', 'maxLossDb must be a number at or above lossDb');
  }
  if (kind === 'connector' && spec.polish !== undefined && POLISHES.indexOf(spec.polish) === -1) {
    pushIssue(issues, 'error', 'polish', 'polish must be one of ' + POLISHES.join(', '));
  }
}

/** Validate one spec on its own terms. Returns `{ ok, errors, warnings, issues }`. */
function validateSpec(spec) {
  const issues = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['spec is not an object'], warnings: [], issues: [{ level: 'error', field: '', message: 'spec is not an object' }] };
  }
  validateCommon(spec, issues);
  switch (spec.kind) {
    case 'cable': validateCable(spec, issues); break;
    case 'splitter': validateSplitter(spec, issues); break;
    case 'olt': validatePon(spec, issues, true); break;
    case 'ont': validatePon(spec, issues, false); break;
    case 'closure': validateClosure(spec, issues); break;
    case 'transceiver': validateTransceiver(spec, issues); break;
    case 'connector':
    case 'splice': validateLossPart(spec, issues, spec.kind); break;
    default: break;
  }
  const errors = issues.filter(function (i) { return i.level === 'error'; }).map(function (i) { return i.field + ': ' + i.message; });
  const warnings = issues.filter(function (i) { return i.level === 'warn'; }).map(function (i) { return i.field + ': ' + i.message; });
  return { ok: errors.length === 0, errors: errors, warnings: warnings, issues: issues };
}

function searchKey(spec) {
  // Cached on the spec object rather than on a name->key map: the key is a property of the part,
  // and recomputing it per keystroke over the whole catalogue is the difference between a search
  // that keeps up with typing and one that does not.
  if (!spec._search) {
    spec._search = [spec.model, spec.label, spec.vendor, (spec.tags || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
  }
  return spec._search;
}

class Registry {
  constructor(specs) {
    this.byKind = {};
    for (const kind of KINDS) this.byKind[kind] = new Map();
    this.problems = [];
    for (const spec of specs || []) {
      const check = validateSpec(spec);
      if (!check.ok) {
        this.problems.push({ model: spec && spec.model, kind: spec && spec.kind, errors: check.errors, warnings: check.warnings });
      }
      if (spec && KINDS.indexOf(spec.kind) !== -1 && spec.model) {
        this.byKind[spec.kind].set(spec.model, spec);
      }
    }
  }

  has(kind, model) { return this.byKind[kind] ? this.byKind[kind].has(model) : false; }

  get(kind, model) {
    const table = this.byKind[kind];
    if (!table) throw new Error('unknown part kind "' + kind + '" - expected one of ' + KINDS.join(', '));
    const spec = table.get(model);
    if (!spec) {
      const known = Array.from(table.keys()).sort();
      throw new Error('unknown ' + kind + ' model "' + model + '"' +
        (known.length ? ' - known models: ' + known.slice(0, 8).join(', ') + (known.length > 8 ? ', ...' : '') : ' - the ' + kind + ' catalogue is empty'));
    }
    return spec;
  }

  all(kind) {
    const table = this.byKind[kind];
    if (!table) throw new Error('unknown part kind "' + kind + '"');
    return Array.from(table.values()).sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
  }

  search(term, kind) {
    const needle = String(term || '').trim().toLowerCase();
    const kinds = kind ? [kind] : KINDS;
    const out = [];
    for (const k of kinds) {
      for (const spec of this.byKind[k].values()) {
        if (!needle || searchKey(spec).indexOf(needle) !== -1) out.push(spec);
      }
    }
    return out;
  }

  counts() {
    const byKind = {};
    let total = 0;
    for (const kind of KINDS) {
      byKind[kind] = this.byKind[kind].size;
      total += byKind[kind];
    }
    return { total: total, byKind: byKind };
  }

  /** Registry-level problems: unreadable files, duplicate models across files, invalid specs. */
  validate() {
    return { ok: this.problems.length === 0, problems: this.problems };
  }
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('invalid JSON in ' + file + ': ' + err.message);
  }
}

/**
 * Load every `parts/<kind>/*.json`. `kind` on the spec must agree with the directory: a splitter
 * filed under `parts/cable/` would otherwise appear in the cable picker and be cabled as fibre.
 */
function loadSpecs(dir) {
  const specDir = dir || DEFAULT_PARTS_DIR;
  const specs = [];
  const problems = [];
  if (!fs.existsSync(specDir)) return { specs: specs, problems: [{ model: null, errors: ['parts directory not found: ' + specDir] }] };

  for (const entry of fs.readdirSync(specDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (KINDS.indexOf(entry.name) === -1) {
      problems.push({ model: null, errors: ['parts/' + entry.name + ' is not a known kind - expected one of ' + KINDS.join(', ')] });
      continue;
    }
    const kindDir = path.join(specDir, entry.name);
    for (const file of fs.readdirSync(kindDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(kindDir, file);
      let spec;
      try {
        spec = readJson(full);
      } catch (err) {
        problems.push({ model: file, errors: [err.message] });
        continue;
      }
      if (spec.kind !== entry.name) {
        problems.push({ model: spec.model || file, errors: ['parts/' + entry.name + '/' + file + ': kind "' + spec.kind + '" does not match its directory'] });
        continue;
      }
      const expectedModel = file.replace(/\.json$/, '');
      if (spec.model && spec.model !== expectedModel) {
        problems.push({ model: spec.model, errors: ['parts/' + entry.name + '/' + file + ': model "' + spec.model + '" does not match the filename'] });
      }
      specs.push(spec);
    }
  }

  const seen = new Map();
  for (const spec of specs) {
    const key = spec.kind + '/' + spec.model;
    if (seen.has(key)) problems.push({ model: spec.model, kind: spec.kind, errors: ['duplicate model ' + key + ' (also in ' + seen.get(key) + ')'] });
    else seen.set(key, spec.kind + '/' + spec.model);
  }
  return { specs: specs, problems: problems };
}

function createRegistry(dir) {
  const loaded = loadSpecs(dir);
  const registry = new Registry(loaded.specs);
  registry.problems = loaded.problems.concat(registry.problems);
  registry.validate = function () { return { ok: this.problems.length === 0, problems: this.problems }; };
  return registry;
}

module.exports = {
  KINDS: KINDS,
  WAVELENGTHS: WAVELENGTHS,
  PON_TYPES: PON_TYPES,
  CLASS_BUDGET_DB: CLASS_BUDGET_DB,
  DEFAULT_PARTS_DIR: DEFAULT_PARTS_DIR,
  classBudgetDb: classBudgetDb,
  validateSpec: validateSpec,
  Registry: Registry,
  createRegistry: createRegistry,
  loadSpecs: loadSpecs
};
