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

const LAT_NAMES = ['lat', 'latitude', 'y'];
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x'];
const LABEL_NAMES = ['label', 'name', 'id', 'ref', 'house', 'premise'];
const ADDRESS_NAMES = ['address', 'addr', 'street', 'direccion', 'endereco', 'direction'];

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function normaliseHeader(cell) {
  return String(cell || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
}

/** RFC-4180-ish field split: quoted fields, doubled quotes, and the delimiter inside quotes. */
function splitRow(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map(function (f) { return f.trim(); });
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
 * Parse CSV text.
 *
 * A header is read when it names a latitude and a longitude column. Without one, the first row is
 * treated as data and the columns are assumed to be `label, lat, lon` - and `assumedHeader` says so,
 * because a silently mis-parsed address list produces a network in the wrong place.
 */
function parseCsv(text, opts) {
  const o = opts || {};
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && l.charAt(0) !== '#'; });

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
      rejected.push({ row: rowNumber, reason: 'latitude or longitude is empty', text: lines[i].slice(0, 120) });
      continue;
    }
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!isNum(lat) || !isNum(lon)) {
      rejected.push({ row: rowNumber, reason: 'latitude/longitude are not numbers', text: lines[i].slice(0, 120) });
      continue;
    }
    const point = { lat: lat, lon: lon };
    if (!geo.isCoordinate(point)) {
      rejected.push({ row: rowNumber, reason: 'latitude/longitude out of range', text: lines[i].slice(0, 120) });
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

function parseArray(rows) {
  const points = [];
  const rejected = [];
  rows.forEach(function (row, i) {
    if (!row || typeof row !== 'object') {
      rejected.push({ row: i + 1, reason: 'row is not an object' });
      return;
    }
    const lat = typeof row.lat === 'number' ? row.lat : Number(row.lat);
    const lon = typeof row.lon === 'number' ? row.lon : Number(row.lon);
    if (!isNum(lat) || !isNum(lon)) {
      rejected.push({ row: i + 1, reason: 'no lat/lon', text: row.address || row.label || '' });
      return;
    }
    if (!geo.isCoordinate({ lat: lat, lon: lon })) {
      rejected.push({ row: i + 1, reason: 'lat/lon out of range', text: row.address || row.label || '' });
      return;
    }
    points.push({ label: row.label || row.name || null, address: row.address || null, lat: lat, lon: lon });
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
