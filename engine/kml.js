"use strict";
/**
 * KML / KMZ import: bring in a route somebody already drew in Google Earth.
 *
 * No dependency, no DOM, no XML parser: KML is a small, predictable subset and a regex that reads
 * three tags is easier to audit than a parser library. The subset handled here is the one that
 * appears in a drawing - Placemark, name, description, Point, LineString, Polygon - and anything
 * else is reported as unsupported rather than silently dropped.
 *
 * **A Placemark is a container, not a geometry.** Google Earth splits a road at every junction and
 * writes one `<Placemark>` holding a `<MultiGeometry>` of several `<LineString>`s. Reading the first
 * geometry of a Placemark and stopping lost every part after it while still reporting
 * `unsupported: 0` - half a street, with a property on the missing half snapped to the far end of
 * the half that was read. So one Placemark now contributes one entry per geometry, in document
 * order, and `unsupported` counts only Placemarks with no geometry this importer understands.
 *
 * KMZ is a zip, and a zip is readable with `zlib` alone. Stored and deflated entries are both
 * handled; Zip64 (a KMZ over 4 GB) is not, and says so.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCoordinates = parseCoordinates;
exports.parseKml = parseKml;
exports.classify = classify;
exports.kmzToKml = kmzToKml;
exports.parseKmz = parseKmz;
const zlib = require("zlib");
const geo_1 = require("./geo");
function escapeTag(tag) {
    return String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Every `<tag>...</tag>`, namespace prefix optional. */
function blocks(xml, tag) {
    const t = escapeTag(tag);
    const re = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + t + '\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?' + t + '>', 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null)
        out.push(m[1]);
    return out;
}
function firstBlock(xml, tag) {
    const all = blocks(xml, tag);
    return all.length ? all[0] : null;
}
function firstText(xml, tag) {
    const inner = firstBlock(xml, tag);
    if (inner === null)
        return null;
    return inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim();
}
/** `lon,lat[,alt]` tuples separated by whitespace -> `{ lat, lon }`. */
function parseCoordinates(text) {
    const out = [];
    for (const tuple of String(text || '').trim().split(/\s+/)) {
        if (!tuple)
            continue;
        const bits = tuple.split(',');
        if (bits.length < 2)
            continue;
        const lon = Number(bits[0]);
        const lat = Number(bits[1]);
        if (!isFinite(lat) || !isFinite(lon))
            continue;
        const point = { lat: lat, lon: lon };
        if (!(0, geo_1.isCoordinate)(point))
            continue;
        if (bits[2] !== undefined && bits[2] !== '' && isFinite(Number(bits[2])))
            point.alt = Number(bits[2]);
        out.push(point);
    }
    return out;
}
/** The shape rules a geometry has to meet before this planner will read it as one. */
function geometryOfCoords(type, coords) {
    if (!coords.length)
        return null;
    if (type === 'Point')
        return { type: 'Point', coords: [coords[0]] };
    if (type === 'LineString' && coords.length >= 2)
        return { type: 'LineString', coords: coords };
    if (type === 'Polygon' && coords.length >= 3)
        return { type: 'Polygon', coords: coords };
    return null;
}
/**
 * Every geometry a Placemark holds, in document order.
 *
 * One scan for the three tags rather than a `firstBlock` per tag: a MultiGeometry holds several of
 * the same tag, and asking for "the" LineString is what truncated the street. A LinearRing is read
 * as a Polygon - the outer boundary of a parcel or building - and is reported as skipped by
 * `classify`, exactly as before. A Placemark with a Polygon and a hole therefore contributes one
 * entry per ring; the hole is a boundary the file drew, and hiding it would be the same silence
 * this change removes.
 */
function geometriesOf(xml) {
    const re = /<(?:[A-Za-z0-9_.-]+:)?(Point|LineString|LinearRing)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?\1>/gi;
    const found = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
        const tag = m[1];
        const type = tag === 'Point' ? 'Point' : tag === 'LineString' ? 'LineString' : 'Polygon';
        const geometry = geometryOfCoords(type, parseCoordinates(firstText(m[2], 'coordinates')));
        if (geometry)
            found.push({ at: m.index, geometry: geometry });
    }
    found.sort(function (a, b) { return a.at - b.at; });
    return found.map(function (f) { return f.geometry; });
}
/**
 * Parse KML text.
 * Returns `{ name, placemarks, unsupported }`. `placemarks` holds **one entry per geometry**, so a
 * Placemark with a MultiGeometry of three lines is three entries; `unsupported` counts Placemarks
 * with no geometry this importer understands (folders of styles, screen overlays, models, a
 * LineString with one coordinate).
 */
function parseKml(text) {
    const xml = String(text || '');
    if (!/<(?:[A-Za-z0-9_.-]+:)?kml\b/i.test(xml)) {
        throw new Error('not a KML document: no <kml> root element');
    }
    const doc = firstBlock(xml, 'Document');
    const docName = doc === null ? null : firstText(doc, 'name');
    const placemarks = [];
    let unsupported = 0;
    for (const body of blocks(xml, 'Placemark')) {
        const geometries = geometriesOf(body);
        const name = firstText(body, 'name');
        const description = firstText(body, 'description');
        if (!geometries.length) {
            unsupported++;
            continue;
        }
        for (const geometry of geometries) {
            placemarks.push({
                name: name || null,
                description: description || null,
                geometry: geometry,
                lengthM: geometry.type === 'LineString' ? Math.round((0, geo_1.pathLengthM)(geometry.coords) * 10) / 10 : null
            });
        }
    }
    return { name: docName, placemarks: placemarks, unsupported: unsupported };
}
function keyOf(point, precision) {
    const p = precision === undefined ? 6 : precision;
    return point.lat.toFixed(p) + ',' + point.lon.toFixed(p);
}
/**
 * Split placemarks into what this planner can use.
 *
 *   routes  - LineStrings, ready to become cable spans (length measured here)
 *   points  - Points, candidates for closures, splitters, ONTs
 *   skipped - anything else, with the reason, so the user is not told "imported 40 items" and
 *             left to discover that 12 of them vanished
 *
 * `dedupe` drops repeated coordinates (a KMZ exported twice, or a shared boundary drawn once per
 * parcel) and reports how many it dropped.
 */
function classify(parsed, opts) {
    const o = opts || {};
    const precision = o.precision === undefined ? 6 : o.precision;
    const seen = new Set();
    const routes = [];
    const points = [];
    const skipped = [];
    let duplicates = 0;
    for (const pm of (parsed && parsed.placemarks) || []) {
        if (pm.geometry.type === 'LineString') {
            const first = pm.geometry.coords[0];
            const last = pm.geometry.coords[pm.geometry.coords.length - 1];
            const key = 'l:' + keyOf(first, precision) + ':' + keyOf(last, precision);
            if (seen.has(key)) {
                duplicates++;
                continue;
            }
            seen.add(key);
            routes.push({
                name: pm.name,
                description: pm.description,
                points: pm.geometry.coords,
                lengthM: pm.lengthM,
                ends: [first, last]
            });
        }
        else if (pm.geometry.type === 'Point') {
            const at = pm.geometry.coords[0];
            const key = 'p:' + keyOf(at, precision);
            if (seen.has(key)) {
                duplicates++;
                continue;
            }
            seen.add(key);
            points.push({ name: pm.name, description: pm.description, lat: at.lat, lon: at.lon });
        }
        else {
            skipped.push({ name: pm.name, type: pm.geometry.type, reason: 'polygons are not imported as cable routes' });
        }
    }
    const routeM = routes.reduce(function (n, r) { return n + (r.lengthM === null ? 0 : r.lengthM); }, 0);
    return {
        routes: routes,
        points: points,
        skipped: skipped,
        duplicates: duplicates,
        routeM: Math.round(routeM * 10) / 10
    };
}
function readCentralDirectory(buf) {
    let eocd = -1;
    const floor = Math.max(0, buf.length - 66000); // EOCD comment can be up to 64 KiB
    for (let i = buf.length - 22; i >= floor; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('not a zip archive: no end-of-central-directory record');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff)
        throw new Error('Zip64 archives are not supported');
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
            break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const uncompSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.push({ name: name, method: method, compSize: compSize, uncompSize: uncompSize, localOffset: localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
function extractEntry(buf, entry) {
    const lh = entry.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
        throw new Error('bad local header for zip entry "' + entry.name + '"');
    }
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + entry.compSize);
    if (entry.method === 0)
        return data;
    if (entry.method === 8)
        return zlib.inflateRawSync(data);
    throw new Error('unsupported compression method ' + entry.method + ' for "' + entry.name + '"');
}
/** Read the first `.kml` inside a KMZ byte buffer. */
function kmzToKml(buf) {
    if (!Buffer.isBuffer(buf))
        throw new TypeError('kmzToKml needs a Buffer');
    const entries = readCentralDirectory(buf);
    const kmlEntry = entries.find(function (e) { return /\.kml$/i.test(e.name); });
    if (!kmlEntry)
        throw new Error('the KMZ contains no .kml file');
    return extractEntry(buf, kmlEntry).toString('utf8');
}
function parseKmz(buf) {
    return parseKml(kmzToKml(buf));
}
