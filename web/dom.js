/**
 * Element creation for the UI, in the right namespace.
 *
 * This is a separate module because getting it wrong is invisible: an SVG child created with
 * `createElementNS(HTML_NS, 'circle')` is in the document, appears in `querySelectorAll`, and is
 * never painted. The first version of `app.js` had exactly that bug - the DOM said four nodes, the
 * screen showed none - so the namespace rule is now a tested function instead of a line inside a
 * builder.
 *
 * Works in the browser (`GFDom`) and in Node (`module.exports`) so `test/ui-dom-contract.test.js`
 * can assert the namespace of every tag without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GFDom = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';

  // Every tag the canvas draws with. Anything not listed is HTML, which is what the panels want.
  const SVG_TAGS = ['svg', 'g', 'circle', 'text', 'line', 'rect', 'path', 'polygon', 'polyline', 'ellipse', 'tspan'];

  function namespaceFor(tag) {
    return SVG_TAGS.indexOf(String(tag).toLowerCase()) !== -1 ? SVG_NS : HTML_NS;
  }

  /**
   * Build an element. `attrs` may carry `text` for textContent; children are appended in order.
   * `doc` defaults to the global document, and is a parameter so a test can supply a stub.
   */
  function el(tag, attrs, children, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) throw new Error('GFDom.el needs a document');
    const node = d.createElementNS(namespaceFor(tag), tag);
    for (const key of Object.keys(attrs || {})) {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  return { SVG_NS: SVG_NS, HTML_NS: HTML_NS, SVG_TAGS: SVG_TAGS, namespaceFor: namespaceFor, el: el };
});
