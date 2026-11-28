'use strict';
/**
 * Demand: the list of addresses a network has to reach.
 *
 * This is the input side of auto-design, and the place where the project's no-outbound-requests rule
 * bites. An address is not a coordinate: turning "12 Calle 3" into lat/lon needs a geocoder, and a
 * geocoder is a network call. `SECURITY.md` says this server makes none, so **coordinates are
 * required** and a row without them is refused with a message that says what to do about it, rather
 * than being dropped (a design silently missing twelve houses is worse than a refusal).
 *
 * Accepted input:
 *   - a JSON array of `{ label?, address?, lat, lon }`
 *   - CSV text with a header naming lat/lon (aliases below), plus optional label/address
 *   - KML points, via `kml.parseKml` + `kml.classify`, converted by the caller
 */

const geo = require('./geo');
const demandText = require('./demand-text');

const LAT_NAMES = ['lat', 'latitude', 'y'];
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x'];
const LABEL_NAMES = ['label', 'name', 'id', 'ref', 'house', 'premise'];
const ADDRESS_NAMES = ['address', 'addr', 'street', 'direccion', 'endereco', 'direction'];

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/**
 * A JSON value or cell as a finite number, or null when it is not one.
 *
 * `Number('')` is 0 - and so are `Number(null)` and `Number(' ')` - and 0,0 passes every range check.
 * Converting before testing the raw value put a blank array cell in the Gulf of Guinea, where it
 * deduped against the other blank cells into one phantom point and never reached `rejected`. The CSV
 * path already tests the raw cell; this is the same test for the other input path.
 */
function numberOrNull(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** True when the value says nothing at all: absent, null, or an empty/whitespace string. */
function isMissing(value) {
  return value === undefined || value === null ||
    (typeof value === 'string' && value.trim() === '');
}

function normaliseHeader(cell) {
  return String(cell || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
}

/**
 * RFC-4180-ish field split: quoted fields, doubled quotes, the delimiter inside quotes, and a quoted
 * field that spans lines.
 *
 * A quote opens a field only where a field starts - the delimiter just before it, or the start of the
 * row - which is the rule RFC 4180 actually states. Treating every quote as the start of a quoted
 * section made an inch mark (`12" duct`) swallow the rest of the row, and the record splitter above,
 * applying the same wrong rule, then treated the following row's quoted address as still open.
 */
function splitRow(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      // A line break inside a quoted field is part of the value (RFC 4180). It is folded to a
      // space rather than kept: a field becomes a node name and a line of the printed plan, and
      // neither was ever meant to carry a newline into the table it is printed in.
      else field += ch === '\n' ? ' ' : ch;
    } else if (ch === '"' && field.trim() === '') quoted = true;
    else if (ch === delimiter) { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map(function (f) { return f.trim(); });
}

/**
 * Split CSV text into records, honouring quoted fields.
 *
 * A quoted field may carry the delimiter (that is `splitRow`'s job) and, per RFC 4180, a line
 * break: `"Unit 4\n12 High Street"` is one address. Splitting the text on a newline first meant
 * that address was cut at the break and its tail parsed as a row with no latitude, so a real address
 * list came back as a truncated address plus a phantom `rejected` point nobody could find in the
 * file. The field splitter already promised quoted fields; this is the record splitter keeping the
 * same promise.
 *
 * An unterminated quote is not RFC 4180 and this importer cannot tell where that field ended, so it
 * returns `null` and the caller falls back to the plain line split - malformed input keeps the answer
 * it has always had instead of swallowing every row after the stray quote into one record.
 */
function splitRecords(text) {
  const records = [];
  let current = '';
  let quoted = false;
  // A quote opens a field only where a field starts - at the start of a record or right after a
  // delimiter (spaces between the two are allowed) - exactly the rule `splitRow` applies. Anything
  // else is text: an inch mark in `12" duct` used to open a quoted section that ran to the next
  // quote in the file, so the record splitter stopped splitting on the newline and an unrelated
  // row's multi-line address was cut in half.
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { current += '""'; i++; continue; }
      if (ch === '"') { quoted = false; atFieldStart = false; }
      current += ch;
      continue;
    }
    if (ch === '"' && atFieldStart) { quoted = true; current += ch; continue; }
    if (ch === '\n') { records.push(current); current = ''; atFieldStart = true; continue; }
    current += ch;
    atFieldStart = ch === ',' || ch === ';' || ch === '\t' ||
      (atFieldStart && (ch === ' ' || ch === '\r'));
  }
  if (quoted) return null;
  records.push(current);
  return records;
}

function sniffDelimiter(headerLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function indexOfAny(header, names) {
  for (let i = 0; i < header.length; i++) {
    if (names.indexOf(normaliseHeader(header[i])) !== -1) return i;
  }
  return -1;
}

/**
 * Is this record a comment, or a row?
 *
 * A record is a row when it carries fields - a delimiter-separated cell - and a comment only when it
 * is one bare `# ...` sentence. The filter used to drop every record whose first character was `#`,
 * and the label column is the first column: an address written the way a street writes it,
 * `#12 Calle 3,51.5,-0.1`, disappeared without a `rejected` entry. Measured on this importer, that
 * file of two houses parsed to `points: 1, rejected: 0` - one house short, with no sentence saying so,
 * which is the silence `demand.js` exists to refuse. The cost of the rule is the other side of the
 * same promise: a note that contains a comma is a row with no coordinates, and it is *rejected by
 * name* rather than swallowed.
 *
 * The delimiter is not known yet when the filter runs (the header names it), so every separator a
 * header may use counts as a field.
 */
function isCommentLine(line) {
  if (line.charAt(0) !== '#') return false;
  return line.indexOf(',') === -1 && line.indexOf(';') === -1 && line.indexOf('	') === -1;
}

/**
 * Parse CSV text.
 *
 * A header is read when it names a latitude and a longitude column. Without one, the first row is
 * treated as data and the columns are assumed to be `label, lat, lon` - and `assumedHeader` says so,
 * because a silently mis-parsed address list produces a network in the wrong place.
 */
function parseCsv(text, opts) {
  const o = opts || {};
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  // Records before lines: a quoted field may carry a line break, so the record splitter has to see
  // the quote before the newline means anything. `null` means the quotes never balanced.
  const records = splitRecords(raw) || raw.split('\n');
  const lines = records
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && !isCommentLine(l); });

  if (!lines.length) throw new Error('the demand list is empty');

  const delimiter = o.delimiter || sniffDelimiter(lines[0]);
  const firstRow = splitRow(lines[0], delimiter);
  let header = firstRow;
  let latIdx = indexOfAny(header, LAT_NAMES);
  let lonIdx = indexOfAny(header, LON_NAMES);
  let assumedHeader = false;
  let bodyStart = 1;

  if (latIdx === -1 || lonIdx === -1) {
    // No named columns: is the first row data? (a numeric 2nd and 3rd cell)
    const looksLikeData = firstRow.length >= 3 && isNum(Number(firstRow[1])) && isNum(Number(firstRow[2]));
    if (!looksLikeData) {
      throw new Error('the CSV needs a header naming a latitude and a longitude column ' +
        '(lat/latitude, lon/lng/long/longitude) - found: ' + firstRow.join(' | '));
    }
    header = ['label', 'lat', 'lon'];
    latIdx = 1;
    lonIdx = 2;
    assumedHeader = true;
    bodyStart = 0;
  }

  const labelIdx = indexOfAny(header, LABEL_NAMES);
  const addressIdx = indexOfAny(header, ADDRESS_NAMES);
  const points = [];
  const rejected = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const row = splitRow(lines[i], delimiter);
    const rowNumber = i + 1;
    if (!row.length || row.every(function (c) { return c === ''; })) continue;
    // An empty cell is not zero: `Number('')` is 0, which would put a house in the Gulf of Guinea
    // and pass every range check.
    const rawLat = row[latIdx];
    const rawLon = row[lonIdx];
    if (rawLat === '' || rawLon === '' || rawLat === undefined || rawLon === undefined) {
      rejected.push({ row: rowNumber, reason: 'latitude or longitude is empty', text: lines[i].replace(/\n/g, ' ').slice(0, 120) });
      continue;
    }
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!isNum(lat) || !isNum(lon)) {
      rejected.push({ row: rowNumber, reason: 'latitude/longitude are not numbers', text: lines[i].replace(/\n/g, ' ').slice(0, 120) });
      continue;
    }
    const point = { lat: lat, lon: lon };
    if (!geo.isCoordinate(point)) {
      rejected.push({ row: rowNumber, reason: 'latitude/longitude out of range', text: lines[i].replace(/\n/g, ' ').slice(0, 120) });
      continue;
    }
    const label = labelIdx !== -1 && row[labelIdx] ? row[labelIdx] : null;
    const address = addressIdx !== -1 && row[addressIdx] ? row[addressIdx] : null;
    points.push({ label: label, address: address, lat: lat, lon: lon });
  }

  return {
    points: points,
    rejected: rejected,
    meta: { delimiter: delimiter === '\t' ? 'tab' : delimiter, header: header, assumedHeader: assumedHeader }
  };
}

/** The row's own words, for a rejection's `text`: the address when it has one, else the label. */
function rowText(row) {
  return demandText.renderValue(isMissing(row.address) ? row.label : row.address);
}

function parseArray(rows) {
  const points = [];
  const rejected = [];
  rows.forEach(function (row, i) {
    if (!row || typeof row !== 'object') {
      rejected.push({ row: i + 1, reason: 'row is not an object' });
      return;
    }
    if (isMissing(row.lat) || isMissing(row.lon)) {
      rejected.push({ row: i + 1, reason: 'latitude or longitude is empty', text: rowText(row) });
      return;
    }
    const lat = numberOrNull(row.lat);
    const lon = numberOrNull(row.lon);
    if (lat === null || lon === null) {
      rejected.push({ row: i + 1, reason: 'latitude/longitude are not numbers', text: rowText(row) });
      return;
    }
    if (!geo.isCoordinate({ lat: lat, lon: lon })) {
      rejected.push({ row: i + 1, reason: 'lat/lon out of range', text: rowText(row) });
      return;
    }
    // A label and an address both become node names in the design and are printed there
    // (`web/scene.js` draws them, the splice page titles itself with them), so both are text.
    // `{ label: 5 }` used to name the ONT node `5`; `{ address: 5 }` was not stringified at all,
    // so one numeric house number made every candidate fail validation with a node id and no row.
    // `engine/demand-text.ts` is the one rule for both fields: a string is itself (blank is absent),
    // a finite number is its decimal text, anything else is refused by row and field.
    const labelValue = isMissing(row.label) ? row.name : row.label;
    const label = isMissing(labelValue)
      ? { ok: true, text: null }
      : demandText.textField(labelValue, 'label');
    if (label.ok === false) {
      rejected.push({ row: i + 1, reason: label.reason, text: demandText.renderValue(labelValue) });
      return;
    }
    const address = demandText.textField(row.address, 'address');
    if (address.ok === false) {
      rejected.push({ row: i + 1, reason: address.reason, text: demandText.renderValue(row.address) });
      return;
    }
    points.push({ label: label.text, address: address.text, lat: lat, lon: lon });
  });
  return { points: points, rejected: rejected };
}

function dedupe(points, precision) {
  const p = precision === undefined ? 6 : precision;
  const seen = new Set();
  const out = [];
  for (const point of points) {
    const key = point.lat.toFixed(p) + ',' + point.lon.toFixed(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return { points: out, duplicates: points.length - out.length };
}

/**
 * Parse and prepare demand for design.
 *
 * Returns `{ points, rejected, duplicates, meta, bbox, geocodingNeeded }`. A point without
 * coordinates is impossible by construction here, so `geocodingNeeded` is always 0 - it exists so a
 * future geocoder has a place to report what it had to look up, and so the field cannot be
 * forgotten when one is added.
 */
function prepare(input, opts) {
  const o = opts || {};
  let parsed;
  if (Array.isArray(input)) {
    parsed = parseArray(input);
    parsed.meta = { delimiter: null, header: null, assumedHeader: false };
  } else if (typeof input === 'string') {
    parsed = parseCsv(input, o);
  } else {
    throw new TypeError('demand must be a CSV string or an array of { lat, lon } rows');
  }

  if (!parsed.points.length) {
    throw new Error('no usable demand points: ' + (parsed.rejected.length
      ? parsed.rejected.length + ' row(s) rejected (' + parsed.rejected[0].reason + ')'
      : 'the list is empty'));
  }

  const deduped = dedupe(parsed.points, o.precision);
  if (deduped.points.length < 1) throw new Error('every demand point is a duplicate of another');

  const points = deduped.points.map(function (p, i) {
    return {
      id: 'd' + (i + 1),
      label: p.label || p.address || 'point ' + (i + 1),
      address: p.address || null,
      lat: p.lat,
      lon: p.lon
    };
  });

  return {
    points: points,
    rejected: parsed.rejected,
    duplicates: deduped.duplicates,
    meta: parsed.meta,
    geocodingNeeded: 0,
    bbox: geo.bbox(points),
    centre: geo.centroid(points)
  };
}

/** A one-line description for a report or an error message. */
function summarise(demand) {
  return demand.points.length + ' point(s)' +
    (demand.duplicates ? ', ' + demand.duplicates + ' duplicate(s) dropped' : '') +
    (demand.rejected.length ? ', ' + demand.rejected.length + ' row(s) rejected' : '');
}

module.exports = {
  LAT_NAMES: LAT_NAMES,
  LON_NAMES: LON_NAMES,
  parseCsv: parseCsv,
  parseArray: parseArray,
  dedupe: dedupe,
  prepare: prepare,
  summarise: summarise
};
