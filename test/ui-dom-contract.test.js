'use strict';
// The DOM contract the UI depends on, without a browser.
//
// The bug this exists for: `app.js` created every SVG child with `createElementNS(HTML_NS, 'circle')`.
// The nodes were in the document, `querySelectorAll` found them, and the canvas was blank - nothing
// in a DOM-free suite could see it. Now the namespace decision is a function with a test.
const { test, assert, done } = require('./harness');
const dom = require('../web/dom');

function stubDocument() {
  const created = [];
  return {
    created: created,
    createElementNS: function (ns, tag) {
      const record = { ns: ns, tag: tag, attrs: {}, children: [], textContent: '' };
      created.push(record);
      return {
        tagName: tag,
        namespaceURI: ns,
        // A real setAttribute coerces to string; the stub does the same so an assertion cannot
        // pass on a value the browser would have stringified.
        setAttribute: function (k, v) { record.attrs[k] = String(v); },
        appendChild: function (child) { record.children.push(child); },
        set textContent(v) { record.textContent = v; },
        get textContent() { return record.textContent; }
      };
    }
  };
}

test('canvas tags are SVG, panel tags are HTML', function () {
  for (const tag of ['g', 'circle', 'text', 'line', 'rect', 'path']) {
    assert.strictEqual(dom.namespaceFor(tag), dom.SVG_NS, tag + ' must be created in the SVG namespace');
  }
  for (const tag of ['div', 'td', 'tr', 'span', 'button', 'table', 'ul', 'li']) {
    assert.strictEqual(dom.namespaceFor(tag), dom.HTML_NS, tag + ' must be created in the HTML namespace');
  }
});

test('a node circle really is created in the SVG namespace', function () {
  const doc = stubDocument();
  dom.el('circle', { cx: 10, cy: 20, r: 8, fill: '#2e9e4f' }, [], doc);
  assert.strictEqual(doc.created.length, 1);
  assert.strictEqual(doc.created[0].ns, dom.SVG_NS);
  assert.strictEqual(doc.created[0].attrs.r, '8');
});

test('text is set through textContent, never innerHTML', function () {
  const doc = stubDocument();
  const node = dom.el('div', { text: '<script>alert(1)</script>' }, [], doc);
  assert.strictEqual(node.textContent, '<script>alert(1)</script>');
  assert.strictEqual(doc.created[0].textContent, '<script>alert(1)</script>');
});

test('children are appended in order', function () {
  const doc = stubDocument();
  const a = dom.el('span', { text: 'a' }, [], doc);
  const b = dom.el('span', { text: 'b' }, [], doc);
  const parent = dom.el('div', {}, [a, b], doc);
  assert.strictEqual(doc.created[doc.created.length - 1].children.length, 2);
  assert.strictEqual(doc.created[doc.created.length - 1].children[0].textContent, 'a');
  assert.ok(parent);
});

test('the SVG tag list is not empty and has no duplicates', function () {
  assert.ok(dom.SVG_TAGS.length >= 6);
  assert.strictEqual(new Set(dom.SVG_TAGS).size, dom.SVG_TAGS.length);
});


test('the plan can leave the browser: print page and a scaled PNG are wired to the toolbar', function () {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.ok(html.indexOf('id="print-plan"') !== -1, 'no Print / PDF control');
  assert.ok(html.indexOf('id="export-png"') !== -1, 'no PNG control');
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.ok(app.indexOf("'/print/project/'") !== -1, 'the print control does not open the print route');
  assert.ok(app.indexOf('GFScene.exportPlan(') !== -1,
    'the PNG export must use the tested scale arithmetic, not its own');
  assert.ok(app.indexOf('toBlob') !== -1, 'the PNG export never rasterises the drawing');
});

test('the served UI loads the modules the app expects', function () {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  for (const script of ['/fiber.js', '/scene.js', '/dom.js', '/app.js']) {
    assert.ok(html.indexOf('src="' + script + '"') !== -1, 'index.html does not load ' + script);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.ok(app.indexOf('GFDom.el') !== -1, 'app.js does not use the namespace-aware element builder');
  assert.ok(app.indexOf('createElementNS') === -1, 'app.js builds elements by hand again');
});
