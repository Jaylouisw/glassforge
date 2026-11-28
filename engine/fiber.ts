/**
 * Fibre identification, as the field actually does it.
 *
 * TIA-598-D colours the twelve fibres of a tube (and the tubes themselves) in a fixed order. A
 * technician opening a closure reads "tube 3, fibre 7 - red", never "strand 31", so every strand
 * this project emits has to be addressable that way and every address a user types has to resolve
 * back to one strand. Colours are load-bearing: a splice diagram whose colours are arbitrary is a
 * diagram nobody can work from in a manhole.
 *
 * Counting is 1-based at both levels, because that is how the hardware is numbered.
 *
 * The module is a browser global as well as a CommonJS module, so it stays a script - no
 * import/export - and the emitted `fiber.js` is served verbatim at `/fiber.js` (see the tail).
 */

interface FibreColour {
  readonly name: string;
  readonly hex: string;
}

/** A repeated position: the base colour plus the TIA-598 marking that tells it from its twin. */
interface MarkedFibreColour extends FibreColour {
  /** `black tracer`, `double black tracer`, `green stripe` - the marking the standard puts on it. */
  readonly marking: string;
  /** How a sheet writes it: `blue with black tracer`. */
  readonly label: string;
}

type ColourInfo = FibreColour | MarkedFibreColour;

interface AddressOptions {
  fibersPerTube?: number;
  prefix?: string;
  padTube?: boolean;
}

interface FibreAddress {
  index: number;
  tube: number;
  fiber: number;
  tubeColor: ColourInfo;
  fiberColor: ColourInfo;
  label: string;
}

interface ParsedAddress extends FibreAddress {
  raw: string;
}

interface BundleAddress {
  index: number;
  cable: number | null;
  strandInCable: number;
  address: FibreAddress;
  label: string;
}

const COLORS: readonly FibreColour[] = [
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
 * TIA-598-D repeats the twelve base colours through position 48, and marks every repeat:
 *
 *   1-12   the base colour
 *   13-24  base + one black tracer        (black takes a white tracer, so it shows)
 *   25-36  base + a double black tracer   (black takes a double white tracer)
 *   37-48  base + a single green stripe   (green takes an orange stripe)
 *
 * Two of those bands are live in this catalogue. In a 24-fibre tube (`atlas-lite-airblown-24`, the
 * largest legal `fibersPerTube`) positions 1-12 wrapped straight onto 13-24: `T01-F01 blue` and
 * `T01-F13 blue`, same name and same hex, in the one tray a crew reads the address from. Positions
 * 25-36 are reached by the tube number on a 432-fibre ribbon cable (36 tubes of twelve), where tube
 * 25 is the same blue as tube 1. The marking is the only thing that tells them apart. 37-48 is
 * unreachable with the catalogue's largest cable, but it is the same rule, so it is carried rather
 * than left as another silent wrap.
 *
 * Above 48 the standard leaves the marking to agreement between maker and buyer, so the base colour
 * returns and the tube/fibre number identifies the position. A 24-fibre tube that ships a natural
 * fibre with a black tracer at position 20 (Corning MiniXtend HD) is a product variant: the cable's
 * own construction sheet wins over this table, and the caveat is written here so it is not
 * discovered in a manhole.
 */
interface ColourBand {
  readonly marking: string;
  readonly exceptOn: string;
  readonly exceptMarking: string;
}

const BANDS: readonly (ColourBand | null)[] = [
  null,
  { marking: 'black tracer', exceptOn: 'black', exceptMarking: 'white tracer' },
  { marking: 'double black tracer', exceptOn: 'black', exceptMarking: 'double white tracer' },
  { marking: 'green stripe', exceptOn: 'green', exceptMarking: 'orange stripe' }
];

/**
 * Colour of a 1-based position in a tube. Positions 1-12 are the base twelve and carry no extra
 * key, so every existing reader of a 12-fibre address sees exactly the object it saw before. A
 * repeat (13 and up) carries `marking` and `label`.
 */
function colorFor(position: number | string): ColourInfo {
  const n = Number(position);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fibre position must be a positive integer, got ' + position);
  const base = COLORS[(n - 1) % COLORS.length];
  const band = BANDS[Math.floor((n - 1) / COLORS.length)];
  if (!band) return base;
  const marking = base.name === band.exceptOn ? band.exceptMarking : band.marking;
  return {
    name: base.name,
    hex: base.hex,
    marking: marking,
    label: base.name + ' with ' + marking
  };
}

function colorName(position: number | string): string {
  return colorFor(position).name;
}

function isStandardColor(name: string): boolean {
  return COLORS.some(function (c) { return c.name === String(name).toLowerCase(); });
}

function fibersPerTubeOf(opts?: AddressOptions): number {
  const n = opts && opts.fibersPerTube !== undefined ? Number(opts.fibersPerTube) : DEFAULT_FIBERS_PER_TUBE;
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new RangeError('fibersPerTube must be an integer 1..24, got ' + (opts && opts.fibersPerTube));
  }
  return n;
}

/**
 * Strand index (1-based, across the whole cable) to a tube/fibre address.
 * Tube 1 holds strands 1..perTube, tube 2 the next block, and so on.
 */
function addressFor(strandIndex: number | string, opts?: AddressOptions): FibreAddress {
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
    fiberColor: colorFor(fiber),
    label: labelFor(tube, fiber, opts)
  };
}

function labelFor(tube: number, fiber: number, opts?: AddressOptions): string {
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
function bundleAddressFor(strandIndex: number | string, fiberCount?: number | null, bundles?: number | null, opts?: AddressOptions): BundleAddress {
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

function tubeCount(fiberCount: number | string, opts?: AddressOptions): number {
  const perTube = fibersPerTubeOf(opts);
  const n = Number(fiberCount);
  if (!Number.isInteger(n) || n < 0) throw new RangeError('fiberCount must be a non-negative integer, got ' + fiberCount);
  return Math.ceil(n / perTube);
}

/** Every strand of a cable, in order. The provenance of every splice diagram in the app. */
function plan(fiberCount: number | string, opts?: AddressOptions): FibreAddress[] {
  const n = Number(fiberCount);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fiberCount must be a positive integer, got ' + fiberCount);
  const out: FibreAddress[] = [];
  for (let i = 1; i <= n; i++) out.push(addressFor(i, opts));
  return out;
}

/**
 * Parse what a person types. Accepts `T01-F07`, `t1f7`, `1-7`, `1/7`, and a bare `31` (a strand
 * index). Returns null when the text is not an address at all, so a caller can tell "unparseable"
 * from "out of range" - which are different errors to a user.
 */
function parseAddress(text: unknown, opts?: AddressOptions): ParsedAddress | null {
  const perTube = fibersPerTubeOf(opts);
  const s = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
  if (!s) return null;

  let tube: number | null = null;
  let fiber: number | null = null;
  let index: number | null = null;
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
  if (tube === null || fiber === null) return null;
  if (tube < 1 || fiber < 1 || fiber > perTube) return null;
  const resolved = (tube - 1) * perTube + fiber;
  return Object.assign(addressFor(resolved, opts), { raw: String(text) });
}

/** Human string for a splice line: `T03-F07 red - green (blue)`. */
function describe(address: FibreAddress | null | undefined): string {
  if (!address || !address.fiberColor) return '';
  const colour = address.fiberColor;
  return address.label + ' ' + ('label' in colour ? colour.label : colour.name);
}

interface FibreApi {
  COLORS: readonly FibreColour[];
  DEFAULT_FIBERS_PER_TUBE: number;
  colorFor: typeof colorFor;
  colorName: typeof colorName;
  isStandardColor: typeof isStandardColor;
  tubeCount: typeof tubeCount;
  addressFor: typeof addressFor;
  bundleAddressFor: typeof bundleAddressFor;
  labelFor: typeof labelFor;
  plan: typeof plan;
  parseAddress: typeof parseAddress;
  describe: typeof describe;
}

const api: FibreApi = {
  COLORS: COLORS,
  DEFAULT_FIBERS_PER_TUBE: DEFAULT_FIBERS_PER_TUBE,
  colorFor: colorFor,
  colorName: colorName,
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
if (typeof self !== 'undefined') (self as unknown as { GFFiber?: FibreApi }).GFFiber = api;
