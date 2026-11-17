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

  function distanceM(a, b) {
    const toRad = function (d) { return (d * Math.PI) / 180; };
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bounds(nodes) {
    const placed = (nodes || []).filter(function (n) {
      return typeof n.lat === 'number' && typeof n.lon === 'number' && isFinite(n.lat) && isFinite(n.lon);
    });
    if (!placed.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const n of placed) {
      minLat = Math.min(minLat, n.lat); maxLat = Math.max(maxLat, n.lat);
      minLon = Math.min(minLon, n.lon); maxLon = Math.max(maxLon, n.lon);
    }
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

    let spanX = box ? (box.maxLon - box.minLon) * mPerDegLon : 0;
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

    const midLon = box ? (box.minLon + box.maxLon) / 2 : 0;
    const midLat = box ? (box.minLat + box.maxLat) / 2 : 0;

    const out = [];
    for (const node of nodes || []) {
      if (typeof node.lat !== 'number' || typeof node.lon !== 'number' || !isFinite(node.lat) || !isFinite(node.lon)) {
        out.push(Object.assign({}, node, { x: width / 2, y: height / 2, placed: false }));
        continue;
      }
      const dx = (node.lon - midLon) * mPerDegLon;
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
      lon: centre.lon + (x - width / 2) / scale / mPerDegLon
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
      const dx = (point.lon - centre.lon) * mPerDegLon;
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

  return {
    distanceM: distanceM,
    bounds: bounds,
    project: project,
    projectPoints: projectPoints,
    unproject: unproject,
    nodeColour: nodeColour,
    nodeLabel: nodeLabel,
    spanLabel: spanLabel
  };
});
