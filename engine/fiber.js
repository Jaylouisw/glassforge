'use strict';
/**
 * Fibre identification, as the field actually does it.
 *
 * TIA-598-D colours the twelve fibres of a tube (and the tubes themselves) in a fixed order. A
 * technician opening a closure reads "tube 3, fibre 7 - red", never "strand 31", so every strand
 * this project emits has to be addressable that way and every address a user types has to resolve
 * back to one strand. Colours are load-bearing: a splice diagram whose colours are arbitrary is a
 * diagram nobody can work from in a manhole.
 *
 * A tube of more than twelve fibres does not simply repeat the colours. Positions 13-24 repeat the
 * twelve with a **black tracer**, and the repeated black (position 20) takes a **white tracer** so it
 * can be seen against itself. Two plain blues in one 24-fibre tray is two indistinguishable fibres to
 * the crew holding the splicer (gh#258).
 *
 * Counting is 1-based at both levels, because that is how the hardware is numbered.
 */

const COLORS = [
  { name: 'blue', hex: '#1f6fd0' },
  { name: 'orange', hex: '#f07f13' },
  { name: 'green', hex: '#2e9e4f' },
  { name: 'brown', hex: '#7b4a24' },
  { name: 'slate', hex: '#7a8493' },
  { name: 'white', hex: '#f0f0f0' },
  { name: 'red', hex: '#d62828' },
  { name: 'black', hex: '#1a1a1a' },
  { name: 'yellow', hex: '#f2c200' },
  { name: 'violet', hex: '#7b3fa0' },
  { name: 'rose', hex: '#e0568c' },
  { name: 'aqua', hex: '#1fb6c9' }
];

const DEFAULT_FIBERS_PER_TUBE = 12;

/**
 * Base colour of a 1-based position in the twelve-colour sequence: a tube number, or a fibre position
 * read without its tracer. Positions past 12 wrap, as the standard repeats, so tube 13 is blue again.
 */
function colorFor(position) {
  const n = Number(position);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fibre position must be a positive integer, got ' + position);
  return COLORS[(n - 1) % COLORS.length];
}

function colorName(position) {
  return colorFor(position).name;
}

function isStandardColor(name) {
  return COLORS.some(function (c) { return c.name === String(name).toLowerCase(); });
}

function fibersPerTubeOf(opts) {
  const n = opts && opts.fibersPerTube !== undefined ? Number(opts.fibersPerTube) : DEFAULT_FIBERS_PER_TUBE;
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new RangeError('fibersPerTube must be an integer 1..24, got ' + (opts && opts.fibersPerTube));
  }
  return n;
}

/**
 * Colour of a 1-based fibre position **inside a tube**, tracer included: `{ name, hex, tracer }`.
 *
 * Positions 1-12 are the plain colours (`tracer: null`). Positions 13-24 repeat them with a black
 * tracer; position 20 is black-on-black, so its tracer is white. Past 24 the marking is the
 * manufacturer's - a Corning 24-fibre tube ships fibre 20 as a natural fibre with a black tracer - so
 * this returns the base colour and no tracer rather than guessing: the T-number identifies the fibre
 * and the cable's construction sheet decides. `fibersPerTube` is capped at 24 today, so the >24 branch
 * is a stated limit, not a live path.
 */
function tubeFiberColor(position) {
  const n = Number(position);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fibre position must be a positive integer, got ' + position);
  const base = COLORS[(n - 1) % COLORS.length];
  if (n <= COLORS.length || n > COLORS.length * 2) {
    return { name: base.name, hex: base.hex, tracer: null };
  }
  return { name: base.name, hex: base.hex, tracer: base.name === 'black' ? 'white' : 'black' };
}

/**
 * The only place the tracer is spelled out: `blue`, `blue with black tracer`. Takes either an
 * address's `fiberColor` (`{ name }`) or a splice row (`{ colour, tracer }`), because both render the
 * same fibre. Served to the browser with the table so the printed plan and the splice tab cannot word
 * the same fibre differently.
 */
function colorText(colour) {
  if (!colour) return '';
  const name = colour.name || colour.colour;
  if (!name) return '';
  return colour.tracer ? name + ' with ' + colour.tracer + ' tracer' : name;
}

/**
 * Strand index (1-based, across the whole cable) to a tube/fibre address.
 * Tube 1 holds strands 1..perTube, tube 2 the next block, and so on.
 */
function addressFor(strandIndex, opts) {
  const perTube = fibersPerTubeOf(opts);
  const index = Number(strandIndex);
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError('strand index must be a positive integer, got ' + strandIndex);
  }
  const tube = Math.ceil(index / perTube);
  const fiber = ((index - 1) % perTube) + 1;
  return {
    index: index,
    tube: tube,
    fiber: fiber,
    tubeColor: colorFor(tube),
    fiberColor: tubeFiberColor(fiber),
    label: labelFor(tube, fiber, opts)
  };
}

function labelFor(tube, fiber, opts) {
  const prefix = (opts && opts.prefix) || 'T';
  const pad = (opts && opts.padTube === false) ? String(tube) : String(tube).padStart(2, '0');
  return prefix + pad + '-F' + String(fiber).padStart(2, '0');
}

/**
 * A strand index on a span that runs `bundles` whole cables -> the cable it is in and the tray inside
 * that cable.
 *
 * `spans[].strands` numbers fibres continuously across the bundle (SPEC §5/§6): on `2 x 12`, strand
 * 13 is the first fibre of the second cable. `addressFor(index)` cannot say that - it reads the index
 * as if it were inside one cable, so strand 18 of a one-tube 12-fibre loose tube printed `T02-F06`,
 * a tube that exists in neither cable. The hand finds a fibre by opening a cable and reading a tray,
 * so the cable dimension is as load-bearing as the tube one.
 *
 * Returns the bare tray `address` (the `addressFor` result, so `parseAddress` still resolves it) and
 * `label`, which is cable-qualified (`C02/T01-F06`) whenever more than one cable runs the span and
 * stays the bare address on a single-cable span. An unknown `fiberCount` leaves `cable` null rather
 * than guessing: the missing figure stays missing, and the label stays bare. An index past the end of
 * the bundle is refused by name - labelling it cable 3 of 2 is the bug this replaces.
 */
function bundleAddressFor(strandIndex, fiberCount, bundles, opts) {
  const index = Number(strandIndex);
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError('strand index must be a positive integer, got ' + strandIndex);
  }
  const n = bundles === undefined || bundles === null ? 1 : Number(bundles);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('bundles must be a positive integer, got ' + bundles);
  const per = fiberCount === undefined || fiberCount === null ? null : Number(fiberCount);
  if (per !== null && (!Number.isInteger(per) || per < 1)) {
    throw new RangeError('fiberCount must be a positive integer, got ' + fiberCount);
  }
  if (per === null) {
    const bare = addressFor(index, opts);
    return { index: index, cable: null, strandInCable: index, address: bare, label: bare.label };
  }
  if (index > per * n) {
    throw new RangeError('strand index ' + index + ' is outside a ' + n + ' x ' + per + '-fibre bundle (' + per * n + ' fibres)');
  }
  const cable = Math.floor((index - 1) / per) + 1;
  const strandInCable = ((index - 1) % per) + 1;
  const address = addressFor(strandInCable, opts);
  const label = n > 1 ? 'C' + String(cable).padStart(2, '0') + '/' + address.label : address.label;
  return { index: index, cable: cable, strandInCable: strandInCable, address: address, label: label };
}

function tubeCount(fiberCount, opts) {
  const perTube = fibersPerTubeOf(opts);
  const n = Number(fiberCount);
  if (!Number.isInteger(n) || n < 0) throw new RangeError('fiberCount must be a non-negative integer, got ' + fiberCount);
  return Math.ceil(n / perTube);
}

/** Every strand of a cable, in order. The provenance of every splice diagram in the app. */
function plan(fiberCount, opts) {
  const n = Number(fiberCount);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fiberCount must be a positive integer, got ' + fiberCount);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(addressFor(i, opts));
  return out;
}

/**
 * Parse what a person types. Accepts `T01-F07`, `t1f7`, `1-7`, `1/7`, and a bare `31` (a strand
 * index). Returns null when the text is not an address at all, so a caller can tell "unparseable"
 * from "out of range" - which are different errors to a user.
 */
function parseAddress(text, opts) {
  const perTube = fibersPerTubeOf(opts);
  const s = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
  if (!s) return null;

  let tube = null, fiber = null, index = null;
  let m = /^t(\d{1,3})\s*[-_/ ]?\s*f(\d{1,2})$/.exec(s);
  if (m) {
    tube = Number(m[1]); fiber = Number(m[2]);
  } else {
    m = /^(\d{1,3})\s*[-_/]\s*(\d{1,2})$/.exec(s);
    if (m) { tube = Number(m[1]); fiber = Number(m[2]); }
    else {
      m = /^(\d{1,5})$/.exec(s);
      if (m) index = Number(m[1]);
    }
  }

  if (index !== null) {
    if (index < 1) return null;
    return Object.assign(addressFor(index, opts), { raw: String(text) });
  }
  if (tube === null) return null;
  if (tube < 1 || fiber < 1 || fiber > perTube) return null;
  const resolved = (tube - 1) * perTube + fiber;
  return Object.assign(addressFor(resolved, opts), { raw: String(text) });
}

/** Human string for a splice line: `T03-F07 red`, or `T01-F13 blue with black tracer`. */
function describe(address) {
  if (!address || !address.fiberColor) return '';
  return address.label + ' ' + colorText(address.fiberColor);
}

const api = {
  COLORS: COLORS,
  DEFAULT_FIBERS_PER_TUBE: DEFAULT_FIBERS_PER_TUBE,
  colorFor: colorFor,
  colorName: colorName,
  tubeFiberColor: tubeFiberColor,
  colorText: colorText,
  isStandardColor: isStandardColor,
  tubeCount: tubeCount,
  addressFor: addressFor,
  bundleAddressFor: bundleAddressFor,
  labelFor: labelFor,
  plan: plan,
  parseAddress: parseAddress,
  describe: describe
};

// Exported twice on purpose: `module.exports` for the engine and the tests, and a browser global
// so the UI colours a strand with the same table the splice diagram was built from. Two copies of
// TIA-598 is exactly the drift this project refuses.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.GFFiber = api;
