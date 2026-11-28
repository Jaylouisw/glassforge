/**
 * Scene geometry for the planner canvas: project coordinates -> SVG pixels.
 *
 * Kept separate from `app.js` and free of the DOM so it can be unit-tested: a projection that puts
 * two nodes on top of each other is a bug you can only see by squinting at a screenshot, and a test
 * can just assert the pixels differ.
 *
 * Works in the browser (global `GFScene`) and in Node (`module.exports`), which is how
 * `test/scene-projection.test.js` drives it without a headless browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GFScene = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_RADIUS_M = 6371008.8;

  /**
   * Longitude difference `to - from` taken the short way round, in (-180, 180].
   *
   * The same arithmetic `engine/geo.ts` uses: 179.95 and -179.95 are 0.1 deg apart, not 359.9.
   * `distanceM` is a great-circle formula and was always right without it; the projection is a
   * planar one, so every offset it draws has to be measured round the join rather than across the
   * planet. For a drawing that does not straddle 180 this is the plain difference.
   */
  function lonDelta(from, to) {
    let d = (to - from) % 360;
    if (d > 180) d -= 360;
    else if (d <= -180) d += 360;
    return d;
  }

  /** A longitude in [-180, 180): one value per meridian, so 180 and -180 are one place. */
  function wrapLon(lon) {
    if (lon >= -180 && lon <= 180) return lon === 180 ? -180 : lon;
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }

  function distanceM(a, b) {
    const toRad = function (d) { return (d * Math.PI) / 180; };
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * The box that covers the nodes, with longitude taken the short way round.
   *
   * `minLon > maxLon` means the box crosses the antimeridian: it runs east from `minLon` through
   * 180 to `maxLon`, and its width is `lonDelta(minLon, maxLon)`. A raw `minLon <= lon <= maxLon`
   * test is only valid on a box that does not cross. Latitude is a plain min/max. The convention is
   * `engine/geo.ts`'s, so a box from `geo.bbox` maps onto a drawing without translation.
   */
  function bounds(nodes) {
    // A project's JSON can hold `null` where a node belongs; the validator names that entry by
    // position, and the drawing skips it rather than throwing where a picture was asked for.
    const placed = (nodes || []).filter(function (n) {
      return !!n && typeof n.lat === 'number' && typeof n.lon === 'number' && isFinite(n.lat) && isFinite(n.lon);
    });
    if (!placed.length) return null;
    let minLat = Infinity, maxLat = -Infinity;
    const lons = [];
    for (const n of placed) {
      minLat = Math.min(minLat, n.lat); maxLat = Math.max(maxLat, n.lat);
      lons.push(n.lon);
    }
    lons.sort(function (a, b) { return a - b; });
    // Longitude is not a plain min/max: min/max of 179.95 and -179.95 is a box 359.9 deg wide, and
    // a 0.15 deg estate either side of 180 was fitted to the planet and drawn on top of itself
    // (gh#255). The covered arc is the complement of the widest gap between the sorted longitudes;
    // when that gap is an interior one the box runs east from `minLon` through 180 to `maxLon`, so
    // `minLon > maxLon` means the box crosses. A tie keeps the wrap gap, which keeps every ordinary
    // drawing exactly as it was.
    let widest = lons[0] + 360 - lons[lons.length - 1];
    let start = 0;
    for (let i = 1; i < lons.length; i++) {
      const gap = lons[i] - lons[i - 1];
      if (gap > widest) { widest = gap; start = i; }
    }
    const minLon = start === 0 ? lons[0] : lons[start];
    const maxLon = start === 0 ? lons[lons.length - 1] : lons[start - 1];
    return { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon };
  }

  /**
   * Project nodes into a `width x height` box with `pad` pixels of margin.
   *
   * Latitude and longitude are scaled by the SAME factor, so a network drawn over a wide area is
   * not stretched: shapes on screen keep the aspect they have on the ground. Small extents (a single
   * node, or a handful at the same coordinates) fall back to a fixed metre-per-pixel scale rather
   * than dividing by zero.
   */
  function project(nodes, opts) {
    const o = opts || {};
    const width = o.width || 800;
    const height = o.height || 480;
    const pad = o.pad === undefined ? 36 : o.pad;
    const box = bounds(nodes);
    const innerW = Math.max(1, width - pad * 2);
    const innerH = Math.max(1, height - pad * 2);

    const centreLat = box ? (box.minLat + box.maxLat) / 2 : 0;
    const mPerDegLat = 111132.95;
    const mPerDegLon = 111319.49 * Math.cos((centreLat * Math.PI) / 180) || 1;

    // The width of the covered arc, not `max - min`: a crossing box has minLon > maxLon.
    let spanX = box ? Math.abs(lonDelta(box.minLon, box.maxLon)) * mPerDegLon : 0;
    let spanY = box ? (box.maxLat - box.minLat) * mPerDegLat : 0;
    const tiny = 25; // metres: below this the view is "one place", not a drawing
    let scale;
    if (spanX < tiny && spanY < tiny) {
      scale = Math.min(innerW, innerH) / (tiny * 2);
      spanX = Math.max(spanX, tiny);
      spanY = Math.max(spanY, tiny);
    } else {
      scale = Math.min(innerW / Math.max(spanX, 1), innerH / Math.max(spanY, 1));
    }

    const midLon = box ? wrapLon(box.minLon + lonDelta(box.minLon, box.maxLon) / 2) : 0;
    const midLat = box ? (box.minLat + box.maxLat) / 2 : 0;

    const out = [];
    for (const node of nodes || []) {
      if (!node) continue;
      if (typeof node.lat !== 'number' || typeof node.lon !== 'number' || !isFinite(node.lat) || !isFinite(node.lon)) {
        out.push(Object.assign({}, node, { x: width / 2, y: height / 2, placed: false }));
        continue;
      }
      const dx = lonDelta(midLon, node.lon) * mPerDegLon;
      const dy = (node.lat - midLat) * mPerDegLat;
      out.push(Object.assign({}, node, {
        x: Math.round((width / 2 + dx * scale) * 10) / 10,
        y: Math.round((height / 2 - dy * scale) * 10) / 10,
        placed: true
      }));
    }

    return {
      nodes: out,
      bounds: box,
      scale: scale,
      metresPerPixel: scale ? 1 / scale : null,
      centre: { lat: midLat, lon: midLon }
    };
  }

  /** Inverse of the projection: a click at (x, y) back to a coordinate. */
  function unproject(x, y, opts) {
    const o = opts || {};
    const width = o.width || 800;
    const height = o.height || 480;
    const centre = o.centre || { lat: 0, lon: 0 };
    const scale = o.scale || 1;
    const mPerDegLat = 111132.95;
    const mPerDegLon = 111319.49 * Math.cos((centre.lat * Math.PI) / 180) || 1;
    return {
      lat: centre.lat + (height / 2 - y) / scale / mPerDegLat,
      lon: wrapLon(centre.lon + (x - width / 2) / scale / mPerDegLon)
    };
  }

  /**
   * Project arbitrary points with the transform `project()` produced.
   *
   * A routed span carries its street geometry, so the drawing has to place points that are not nodes.
   * Sharing the transform is the only way a polyline and the node it ends on agree.
   */
  function projectPoints(points, transform) {
    const t = transform || {};
    const width = t.width || 800;
    const height = t.height || 480;
    const scale = t.scale || 1;
    const centre = t.centre || { lat: 0, lon: 0 };
    const mPerDegLat = 111132.95;
    const mPerDegLon = 111319.49 * Math.cos((centre.lat * Math.PI) / 180) || 1;
    return (points || []).map(function (point) {
      const dx = lonDelta(centre.lon, point.lon) * mPerDegLon;
      const dy = (point.lat - centre.lat) * mPerDegLat;
      return {
        x: Math.round((width / 2 + dx * scale) * 10) / 10,
        y: Math.round((height / 2 - dy * scale) * 10) / 10
      };
    });
  }

  const COLOURS = { olt: '#7b3fa0', closure: '#4a5568', splitter: '#f07f13', ont: '#2e9e4f' };

  function nodeColour(node) {
    return COLOURS[node.type] || '#4a5568';
  }

  function nodeLabel(node, index) {
    const n = node.name || node.model || node.id || 'node';
    return n.length > 22 ? n.slice(0, 21) + '…' : n;
  }

  /** A short, stable label for a span: its cable's fibre count plus its measured length. */
  function spanLabel(span) {
    const metres = typeof span.lengthM === 'number' ? Math.round(span.lengthM) + ' m' : '?';
    return metres;
  }


  /**
   * A scale bar for a drawing: the largest 1-2-5 x 10^n number of metres that still fits inside
   * `maxPx`. A printed plan with no scale bar is a picture, not a plan; a scale bar computed from a
   * missing projection would be a lie, so a non-positive metresPerPixel throws instead of drawing 0.
   */
  function scaleBar(metresPerPixel, maxPx) {
    const mpp = Number(metresPerPixel);
    if (!isFinite(mpp) || mpp <= 0) {
      throw new TypeError('scaleBar needs a positive metresPerPixel, got ' + metresPerPixel);
    }
    const limit = isFinite(maxPx) && maxPx > 0 ? maxPx : 120;
    const maxM = limit * mpp;
    let metres = 0;
    for (let exp = -9; exp <= 9; exp++) {
      for (const step of [1, 2, 5]) {
        const candidate = step * Math.pow(10, exp);
        if (candidate <= maxM) metres = candidate;
      }
    }
    return { metres: metres, pixels: metres / mpp, label: metresLabel(metres) };
  }

  function metresLabel(metres) {
    if (metres >= 1000) return trimNumber(metres / 1000) + ' km';
    if (metres >= 1) return trimNumber(metres) + ' m';
    return trimNumber(metres * 100) + ' cm';
  }

  function trimNumber(n) {
    return String(Number(n.toFixed(3)));
  }

  /**
   * The size and scale of a raster export of a projected canvas. The PNG is drawn at `zoom` device
   * pixels per canvas pixel, so one exported pixel covers `metresPerPixel / zoom` metres and the
   * figure printed on the drawing has to say so.
   */
  function exportPlan(transform, zoom) {
    const t = transform || {};
    const mpp = Number(t.metresPerPixel);
    if (!isFinite(mpp) || mpp <= 0) {
      throw new TypeError('exportPlan needs transform.metresPerPixel (project() provides it)');
    }
    const z = zoom === undefined ? 2 : Number(zoom);
    if (!isFinite(z) || z <= 0) throw new TypeError('exportPlan zoom must be a positive number, got ' + zoom);
    const width = t.width || 900;
    const height = t.height || 560;
    const exportedMpp = mpp / z;
    return {
      zoom: z,
      width: Math.round(width * z),
      height: Math.round(height * z),
      metresPerPixel: exportedMpp,
      label: '1 px = ' + trimNumber(exportedMpp) + ' m at ' + trimNumber(z) + '\u00d7'
    };
  }

  return {
    distanceM: distanceM,
    bounds: bounds,
    project: project,
    projectPoints: projectPoints,
    unproject: unproject,
    nodeColour: nodeColour,
    nodeLabel: nodeLabel,
    spanLabel: spanLabel,
    scaleBar: scaleBar,
    exportPlan: exportPlan
  };
});
