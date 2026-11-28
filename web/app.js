/* Glassforge UI — no framework, no build step, no CDN. */
(function () {
  'use strict';

  const state = {
    registry: { counts: null, parts: {} },
    project: null,
    tool: 'select',
    network: null,
    connectFrom: null,
    selected: null,
    tab: 'signal',
    derived: null,
    budget: null,
    bom: null,
    strands: null,
    checks: null,
    lastScene: null
  };

  const $ = function (sel) { return document.querySelector(sel); };
  // Building an element in the wrong namespace is the one UI bug that is invisible to the DOM and to
  // every screenshot-free test, so the rule lives in `dom.js` with an assertion on it.
  const el = GFDom.el;

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || (res.status + ' ' + res.statusText));
          return body;
        });
      });
  }

  function banner(message, kind) {
    const box = $('#banner');
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = message;
    box.style.borderColor = kind === 'ok' ? 'var(--ok)' : 'var(--fail)';
  }

  // ---------------------------------------------------------------- loading

  function loadParts(term) {
    return api('/api/parts' + (term ? '?q=' + encodeURIComponent(term) : '')).then(function (payload) {
      state.registry = payload;
      $('#part-counts').textContent = payload.counts.total + ' parts';
      renderPalette();
    });
  }

  function loadProjects() {
    return api('/api/projects').then(function (payload) {
      const list = $('#project-list');
      list.textContent = '';
      for (const project of payload.projects) {
        const li = el('li', {});
        if (state.project && state.project.id === project.id) li.className = 'active';
        li.appendChild(el('div', { text: project.name }));
        li.appendChild(el('div', { class: 'meta', text: (project.nodes || 0) + ' nodes · ' + (project.spans || 0) + ' spans · ' + (project.onts || 0) + ' ONT' }));
        li.addEventListener('click', function () { openProject(project.id); });
        list.appendChild(li);
      }
      if (!payload.projects.length) list.appendChild(el('li', { class: 'muted', text: 'No projects yet — press New.' }));
    });
  }

  function openProject(id) {
    return api('/api/projects/' + id).then(function (project) {
      state.project = project;
      state.derived = project.derived;
      state.budget = null; state.bom = null; state.strands = null;
      $('#project-name').value = project.name;
      const root = (project.nodes || []).find(function (n) { return n.type === 'olt' || n.type === 'headend'; });
      if (root && typeof root.lat === 'number' && typeof root.lon === 'number') {
        if (!$('#he-lat').value) $('#he-lat').value = root.lat;
        if (!$('#he-lon').value) $('#he-lon').value = root.lon;
      }
      localStorage.setItem('gf:lastProject', id);
      renderAll();
      return loadProjects();
    });
  }

  function newProject() {
    const name = prompt('Project name', 'Neighbourhood FTTH');
    if (!name) return Promise.resolve();
    return api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name }) }).then(function (project) {
      return openProject(project.id);
    });
  }

  function refresh() {
    if (!state.project) return Promise.resolve();
    return openProject(state.project.id);
  }

  // ---------------------------------------------------------------- rendering

  function renderPalette() {
    const box = $('#palette');
    box.textContent = '';
    const order = ['olt', 'splitter', 'ont', 'cable', 'closure', 'connector', 'splice'];
    for (const kind of order) {
      const parts = (state.registry.parts && state.registry.parts[kind]) || [];
      if (!parts.length) continue;
      box.appendChild(el('h2', { text: kind + ' (' + parts.length + ')' }));
      for (const part of parts) {
        const row = el('div', { class: 'part' });
        row.appendChild(el('div', { text: part.label }));
        const meta = (kind === 'cable')
          ? part.fiberCount + 'F · ' + Object.keys(part.attenuationDbPerKm).map(function (k) { return k + 'nm ' + part.attenuationDbPerKm[k]; }).join(' · ')
          : (kind === 'splitter') ? '1:' + part.ratio + ' · ' + (part.splitLossDb + part.excessLossDb).toFixed(2) + ' dB'
          : (kind === 'olt' || kind === 'ont') ? part.pon + (part.class ? ' ' + part.class : '') + ' · ' + (part.rxSensitivityDbm) + ' dBm rx'
          : (part.lossDb !== undefined ? part.lossDb + ' dB' : '');
        row.appendChild(el('div', { class: 'meta', text: meta }));
        row.addEventListener('click', function () { pickPart(kind, part); });
        box.appendChild(row);
      }
    }
  }

  function pickPart(kind, part) {
    if (kind === 'cable') {
      state.selectedCable = part.model;
      banner('Cable for new spans: ' + part.label, 'ok');
      return;
    }
    const type = kind === 'olt' ? 'olt' : kind === 'splitter' ? 'splitter' : kind === 'ont' ? 'ont' : 'closure';
    api('/api/projects/' + state.project.id + '/ops', {
      method: 'POST',
      body: JSON.stringify({ op: 'add-node', node: { type: type, model: part.model, name: part.label } })
    }).then(function (project) {
      state.project = project;
      state.derived = project.derived;
      renderAll(); loadProjects();
    }).catch(function (err) { banner(err.message); });
  }

  function renderCanvas() {
    const svg = $('#canvas');
    const spansLayer = $('#layer-spans');
    const nodesLayer = $('#layer-nodes');
    spansLayer.textContent = '';
    nodesLayer.textContent = '';
    if (!state.project) return;

    const width = 900, height = 560;
    const scene = GFScene.project(state.project.nodes || [], { width: width, height: height, pad: 46 });
    state.lastScene = scene;
    const byId = new Map(scene.nodes.map(function (n) { return [n.id, n]; }));

    for (const span of state.project.spans || []) {
      const a = byId.get(span.from);
      const b = byId.get(span.to);
      if (!a || !b) continue;
      if (Array.isArray(span.route) && span.route.length > 2) {
        // A routed span follows the street: draw the geometry, not a chord across the block.
        const projected = GFScene.projectPoints(span.route, { width: width, height: height, scale: scene.scale, centre: scene.centre });
        const points = projected.map(function (p) { return p.x + ',' + p.y; }).join(' ');
        spansLayer.appendChild(el('polyline', {
          points: points, fill: 'none', stroke: '#3d4b5a', 'stroke-width': 2.5,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }));
      } else {
        spansLayer.appendChild(el('line', {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          stroke: '#3d4b5a', 'stroke-width': 2.5, 'stroke-linecap': 'round'
        }));
      }
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4 };
      spansLayer.appendChild(el('text', {
        x: mid.x, y: mid.y, fill: '#93a1b0', 'font-size': '10', 'text-anchor': 'middle',
        text: GFScene.spanLabel(span)
      }));
    }

    for (const node of scene.nodes) {
      const group = el('g', { class: 'node', 'data-id': node.id, style: 'cursor:pointer' });
      const colour = GFScene.nodeColour(node);
      const radius = node.type === 'olt' ? 14 : node.type === 'splitter' ? 10 : node.type === 'ont' ? 8 : 11;
      group.appendChild(el('circle', {
        cx: node.x, cy: node.y, r: radius, fill: colour,
        stroke: state.selected === node.id ? '#1fb6c9' : '#0b0f13', 'stroke-width': state.selected === node.id ? 3 : 1.5
      }));
      group.appendChild(el('text', {
        x: node.x, y: node.y + radius + 14, fill: '#cbd5e1', 'font-size': '11', 'text-anchor': 'middle',
        text: GFScene.nodeLabel(node)
      }));
      group.addEventListener('click', function (event) { onNodeClick(node, event); });
      nodesLayer.appendChild(group);
    }
  }

  function renderRight() {
    const body = $('#tab-body');
    body.textContent = '';
    if (state.tab === 'auto') return renderAuto(body);
    if (!state.project) { body.appendChild(el('p', { class: 'muted', text: 'No project open.' })); return; }
    if (state.tab === 'signal') return renderSignal(body);
    if (state.tab === 'cable') return renderCable(body);
    if (state.tab === 'strands') return renderStrands(body);
    if (state.tab === 'splice') return renderSplice(body);
    return renderChecks(body);
  }

  // The Signal tab is two links over one ODN, and it asked for one of them (#185).
  //
  // A PON launches into the ONT at 1490 nm and the ONT launches into the OLT at 1310 nm; on an active
  // plant `pointToPoint` answers the pair's own two directions the same way, because which end
  // launches changes with the direction. The two disagree exactly where it costs money: a C+ card
  // behind 11.53 dB of ODN is `ok` downstream - with the launch-window warning and a 4 dB pad - and
  // `fail` upstream, -11.22 dBm onto a receiver whose overload is -12 dBm. Only the upstream pass
  // names the pad that actually clears it, so both passes are fetched and the upstream verdict sits
  // beside the downstream one instead of behind it.
  //
  // One request's failure never blanks the other: a plant whose path cannot be budgeted already says
  // so in the downstream rows, and losing the whole tab to the second call would be a worse page than
  // the one with a note on it.
  function loadBudgetPair(projectId) {
    const post = function (body) {
      return api('/api/projects/' + projectId + '/budget', { method: 'POST', body: JSON.stringify(body) });
    };
    return post({}).then(function (down) {
      const pair = { down: down.budgets, up: null, upError: null };
      return post({ direction: 'up' })
        .then(function (up) { pair.up = up.budgets; return pair; })
        .catch(function (err) { pair.upError = err.message; return pair; });
    });
  }

  // One direction of one ONT's link: the verdict, the figures it was made from, its reasons and its
  // warnings. A warning is not a reason - a verdict can be `ok` and the design still depend on a cold
  // optic, because overload is judged at the bottom of the launch window (#111) - so both lists are
  // read. The heading and the rows come from `GFSignal`, which the test drives with real payloads.
  function directionBlock(result) {
    const block = el('div', { class: 'direction' });
    const head = el('h4', {});
    head.appendChild(el('span', { text: GFSignal.title(result) }));
    head.appendChild(el('span', { class: 'verdict ' + result.verdict, text: result.verdict.toUpperCase() }));
    block.appendChild(head);
    const table = el('table', {});
    for (const row of GFSignal.rows(result)) {
      const tr = el('tr', {});
      tr.appendChild(el('th', { text: row[0] }));
      tr.appendChild(el('td', { class: 'num', text: row[1] }));
      table.appendChild(tr);
    }
    block.appendChild(table);
    if (result.reasons.length) {
      const list = el('ul', { class: 'err' });
      for (const reason of result.reasons) list.appendChild(el('li', { text: reason }));
      block.appendChild(list);
    }
    if (result.warnings && result.warnings.length) {
      const list = el('ul', { class: 'warn' });
      for (const warning of result.warnings) list.appendChild(el('li', { text: warning }));
      block.appendChild(list);
    }
    const details = el('details', {});
    details.appendChild(el('summary', { class: 'muted', text: 'Loss breakdown' }));
    const inner = el('table', {});
    for (const line of result.breakdown) {
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: line.label }));
      tr.appendChild(el('td', { class: 'num', text: line.db + ' dB' }));
      inner.appendChild(tr);
    }
    details.appendChild(inner);
    block.appendChild(details);
    return block;
  }

  function renderSignal(body) {
    if (!state.budget) {
      body.appendChild(el('p', { class: 'muted', text: 'Loading budgets…' }));
      loadBudgetPair(state.project.id)
        .then(function (pair) { state.budget = pair; renderRight(); })
        .catch(function (err) { body.textContent = ''; body.appendChild(el('p', { class: 'err', text: err.message })); });
      return;
    }
    if (!state.budget.down.length) { body.appendChild(el('p', { class: 'muted', text: 'No ONTs yet: place one to see a power budget.' })); return; }
    // An upstream pass that could not run is news, not silence: it names the half of the plant that
    // was not measured, and the downstream cards are still worth reading.
    if (state.budget.upError) {
      body.appendChild(el('p', { class: 'warn', text: 'The upstream direction could not be budgeted: ' + state.budget.upError }));
    }
    for (const card of GFSignal.merge(state.budget.down, state.budget.up)) {
      const box = el('div', { class: 'card' });
      box.appendChild(el('h3', { text: card.name || card.ont }));
      // A row that cannot be budgeted at all is a fault in the path, not in one direction, and the
      // upstream pass reports the same path fault: saying it twice reads as two problems.
      if (card.error) {
        box.appendChild(el('p', { class: 'err', text: card.error }));
        body.appendChild(box);
        continue;
      }
      box.appendChild(directionBlock(card.down));
      if (card.upError) box.appendChild(el('p', { class: 'warn', text: 'Upstream: ' + card.upError }));
      else if (card.up) box.appendChild(directionBlock(card.up));
      body.appendChild(box);
    }
  }

  function renderCable(body) {
    if (!state.bom) {
      body.appendChild(el('p', { class: 'muted', text: 'Loading bill of materials…' }));
      api('/api/projects/' + state.project.id + '/bom').then(function (bom) { state.bom = bom; renderRight(); })
        .catch(function (err) { body.textContent = ''; body.appendChild(el('p', { class: 'err', text: err.message })); });
      return;
    }
    if (!state.bom.byCable.length) { body.appendChild(el('p', { class: 'muted', text: 'No measured spans yet.' })); return; }
    const table = el('table', {});
    const head = el('tr', {});
    ['Cable', 'Design m', 'Drums', 'Buy m'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    table.appendChild(head);
    for (const row of state.bom.byCable) {
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: row.model }));
      tr.appendChild(el('td', { class: 'num', text: String(row.designM) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.drums) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.purchaseM) }));
      table.appendChild(tr);
    }
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: 'Cable to buy' }));
    card.appendChild(table);
    card.appendChild(el('p', { class: 'muted', text: 'Route + 3% overlength + 30 m per splice + 20 m per closure, rounded to whole drums.' }));
    body.appendChild(card);
  }

  function renderStrands(body) {
    if (!state.strands) {
      api('/api/projects/' + state.project.id + '/strands').then(function (s) { state.strands = s; renderRight(); })
        .catch(function (err) { body.textContent = ''; body.appendChild(el('p', { class: 'err', text: err.message })); });
      return;
    }
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: 'Strand usage' }));
    card.appendChild(el('p', { class: 'muted', text: state.strands.totalUsed + ' of ' + state.strands.totalStrands + ' strands used (' + state.strands.utilisation + '%)' }));
    const table = el('table', {});
    const head = el('tr', {});
    ['Span', 'Cable', 'Used', 'Spare'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    table.appendChild(head);
    for (const row of state.strands.rows) {
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: row.span }));
      tr.appendChild(el('td', { text: row.cable + ' (' + row.fiberCount + 'F)' }));
      tr.appendChild(el('td', { class: 'num' + (row.error ? ' err' : ''), text: String(row.used) }));
      tr.appendChild(el('td', { class: 'num', text: row.spare === null ? '—' : String(row.spare) }));
      table.appendChild(tr);
    }
    card.appendChild(table);
    body.appendChild(card);
  }

  function spliceFor(nodeId) {
    const project = state.project;
    const node = (project.nodes || []).find(function (n) { return n.id === nodeId; });
    if (!node) return null;
    const spans = (project.spans || []).filter(function (s) { return s.from === nodeId || s.to === nodeId; });
    const rows = [];
    const seen = new Set();
    for (const span of spans) {
      for (const index of span.strands || []) {
        const key = span.id + ':' + index;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ span: span.id, index: index });
      }
    }
    return { node: node, spans: spans, rows: rows };
  }

  function renderSplice(body) {
    if (!state.selected) { body.appendChild(el('p', { class: 'muted', text: 'Select a closure on the canvas to open its splice diagram.' })); return; }
    const splice = spliceFor(state.selected);
    if (!splice) { body.appendChild(el('p', { class: 'muted', text: 'Selected node is not a closure.' })); return; }
    // The strand address is a property of the cable it is in: a 24-per-tube ribbon's strand 25 is
    // T02-F01, not T03-F01, and on a bundled span the index runs across every cable, so the row must
    // also name which cable (`C02/T01-F06`). The catalogue is already in `state.registry`, so read the
    // geometry from there rather than assuming the standard's default of twelve (what the engine does).
    const geometry = {};
    const cables = (state.registry.parts && state.registry.parts.cable) || [];
    for (const span of splice.spans) {
      const cable = cables.find(function (c) { return c.model === span.cable; });
      geometry[span.id] = {
        fibersPerTube: cable && typeof cable.fibersPerTube === 'number' ? cable.fibersPerTube : null,
        fiberCount: cable && typeof cable.fiberCount === 'number' ? cable.fiberCount : null,
        bundles: typeof span.bundles === 'number' && span.bundles > 1 ? span.bundles : 1
      };
    }
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: (splice.node.name || splice.node.id) + ' — thread diagram' }));
    card.appendChild(el('p', { class: 'muted', text: splice.spans.length + ' cables, ' + splice.rows.length + ' strands in use' }));
    const table = el('table', {});
    const head = el('tr', {});
    ['Span', 'Strand', 'Address', 'Colour'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    table.appendChild(head);
    for (const row of splice.rows) {
      const geo = geometry[row.span] || { fibersPerTube: null, fiberCount: null, bundles: 1 };
      // A hand-edited project can list a strand its cable does not have; the engine's sheet skips it
      // and so does the tab, rather than letting one bad entry blank the diagram.
      if (geo.fiberCount && row.index > geo.fiberCount * geo.bundles) continue;
      const at = GFFiber.bundleAddressFor(row.index, geo.fiberCount, geo.bundles,
        geo.fibersPerTube ? { fibersPerTube: geo.fibersPerTube } : undefined);
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: row.span }));
      tr.appendChild(el('td', { class: 'num', text: String(row.index) }));
      tr.appendChild(el('td', { text: at.label }));
      const td = el('td', {});
      const sw = el('span', { class: 'swatch' });
      sw.style.background = at.address.fiberColor.hex;
      td.appendChild(sw);
      // `label` carries the TIA-598 tracer where the position repeats a colour (a 24-fibre tube's
      // F13 is `blue with black tracer`, not a second plain `blue` beside F01).
      td.appendChild(el('span', { text: at.address.fiberColor.label || at.address.fiberColor.name }));
      tr.appendChild(td);
      table.appendChild(tr);
    }
    card.appendChild(table);
    if (!splice.rows.length) card.appendChild(el('p', { class: 'muted', text: 'No strands assigned to these spans yet.' }));
    body.appendChild(card);
  }

  function renderAuto(body) {
    if (!state.auto) {
      body.appendChild(el('p', { class: 'muted', text: 'Paste a demand list on the left, give the head-end coordinates, and press Design.' }));
      return;
    }
    const result = state.auto;
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: result.ok ? result.best.label : 'No feasible design' }));
    card.appendChild(el('p', {
      class: 'muted',
      text: result.demand.points + ' point(s) · ' + result.routeMethod + ' · ranked by ' + result.objective
    }));
    const rationale = el('ul', {});
    for (const line of result.rationale) rationale.appendChild(el('li', { text: line }));
    card.appendChild(rationale);
    if (result.notes && result.notes.length) {
      const notes = el('ul', { class: 'muted' });
      for (const note of result.notes) notes.appendChild(el('li', { text: note }));
      card.appendChild(notes);
    }
    // The winning design's warnings, because a budget warning is only worth computing if somebody
    // reads it (#111). The one that matters here is the launch-window band: a PON estate inside it
    // passes at the floor launch and overdrives its ONTs with a hot line card, and this tab is where
    // the plan is proposed and applied.
    if (result.best && result.best.warnings && result.best.warnings.length) {
      card.appendChild(el('h3', { text: result.best.warnings.length + ' warning(s)' }));
      const warnings = el('ul', { class: 'muted' });
      for (const warning of result.best.warnings) warnings.appendChild(el('li', { text: warning }));
      card.appendChild(warnings);
    }
    if (result.ok) {
      const apply = el('button', { text: 'Apply to this project' });
      apply.addEventListener('click', applyAutoDesign);
      card.appendChild(apply);
    }
    body.appendChild(card);

    // The columns and their cells come from `web/auto.js`, not from an array here: the table must
    // show the number the ranking used (cost, when a cost model was supplied) and the upstream
    // direction of every ONT's link (#185), and a hand-written header is how both went missing.
    // Header and rows are built from one key list, so they cannot disagree about a column.
    const columns = GFAuto.columns(result.objective);
    const table = el('table', {});
    const head = el('tr', {});
    columns.forEach(function (column) {
      const th = el('th', { text: column.label });
      if (column.hint) th.title = column.hint;
      head.appendChild(th);
    });
    table.appendChild(head);
    for (const candidate of result.candidates) {
      const tr = el('tr', {});
      for (const cell of GFAuto.cells(candidate, result.objective)) {
        tr.appendChild(el('td', { class: cell.cls, text: cell.text }));
      }
      table.appendChild(tr);
      if (!candidate.feasible) {
        const reason = el('tr', {});
        const cell = el('td', { class: 'err', colspan: String(columns.length), text: candidate.reasons[0] || 'infeasible' });
        reason.appendChild(cell);
        table.appendChild(reason);
      }
    }
    const compare = el('div', { class: 'card' });
    compare.appendChild(el('h3', { text: 'Candidates' }));
    compare.appendChild(table);
    body.appendChild(compare);

    if (result.plant) {
      const runs = el('div', { class: 'card' });
      runs.appendChild(el('h3', { text: 'Runs (' + result.runs.length + ')' }));
      const rt = el('table', {});
      const rh = el('tr', {});
      ['Run', 'Purpose', 'Cable', 'm'].forEach(function (h) { rh.appendChild(el('th', { text: h })); });
      rt.appendChild(rh);
      for (const run of result.runs.slice(0, 40)) {
        const tr = el('tr', {});
        tr.appendChild(el('td', { text: run.id }));
        tr.appendChild(el('td', { text: run.purpose }));
        tr.appendChild(el('td', { text: run.cable }));
        tr.appendChild(el('td', { class: 'num', text: String(run.lengthM) }));
        rt.appendChild(tr);
      }
      runs.appendChild(rt);
      if (result.runs.length > 40) runs.appendChild(el('p', { class: 'muted', text: '…and ' + (result.runs.length - 40) + ' more' }));
      body.appendChild(runs);
    }
  }

  function autoPayload() {
    const text = $('#demand-input').value.trim();
    if (!text) throw new Error('paste a demand list first (label,lat,lon per line)');
    const lat = Number($('#he-lat').value);
    const lon = Number($('#he-lon').value);
    if (!isFinite(lat) || !isFinite(lon) || $('#he-lat').value === '' || $('#he-lon').value === '') {
      throw new Error('the head-end needs a latitude and a longitude');
    }
    const payload = {
      demand: text,
      headEnd: { lat: lat, lon: lon, name: 'Head-end' },
      technology: $('#auto-tech').value
    };
    if (state.network) payload.network = state.network;
    return payload;
  }

  function importNetwork(file) {
    const isKmz = /\.kmz$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = function () {
      fetch('/api/import/network', {
        method: 'POST',
        headers: { 'Content-Type': isKmz ? 'application/vnd.google-earth.kmz' : 'application/vnd.google-earth.kml+xml' },
        body: reader.result
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
          return body;
        });
      }).then(function (result) {
        state.network = { edges: result.edges };
        $('#network-status').textContent = 'network: ' + result.stats.edges + ' edges, ' + result.stats.lengthKm + ' km';
        banner('Street network loaded: ' + result.stats.edges + ' edges over ' + result.stats.lengthKm + ' km.', 'ok');
      }).catch(function (err) {
        state.network = null;
        $('#network-status').textContent = 'network: not loaded';
        banner('Street network import failed: ' + err.message);
      });
    };
    if (isKmz) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  function runAutoDesign() {
    let payload;
    try { payload = autoPayload(); } catch (err) { $('#auto-status').textContent = err.message; return; }
    $('#auto-status').textContent = 'Designing…';
    api('/api/design/synthesise', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (result) {
        state.auto = result;
        state.autoPayload = payload;
        state.tab = 'auto';
        syncTabs();
        $('#auto-status').textContent = result.ok
          ? result.technology + ' wins: ' + result.best.metrics.fibreMetres + ' fibre-metres'
          : 'no feasible design — see the reasons';
        renderRight();
      })
      .catch(function (err) {
        $('#auto-status').textContent = err.message;
        banner('Auto-design failed: ' + err.message);
      });
  }

  function applyAutoDesign() {
    if (!state.project || !state.autoPayload) return;
    const payload = Object.assign({}, state.autoPayload, { applyToProject: state.project.id });
    api('/api/design/synthesise', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (result) {
        state.auto = result;
        banner('Applied ' + result.best.label + ' to the project (' + result.applied.nodes + ' nodes, ' + result.applied.spans + ' spans).', 'ok');
        return openProject(state.project.id);
      })
      .catch(function (err) { banner('Apply failed: ' + err.message); });
  }

  function renderChecks(body) {
    const derived = state.derived || {};
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: 'Validation' }));
    const errors = derived.errors || [];
    const warnings = derived.warnings || [];
    if (!errors.length && !warnings.length) card.appendChild(el('p', { class: 'muted', text: 'Nothing to report.' }));
    if (errors.length) {
      card.appendChild(el('h3', { class: 'err', text: errors.length + ' error(s)' }));
      const list = el('ul', { class: 'err' });
      errors.forEach(function (e) { list.appendChild(el('li', { text: e })); });
      card.appendChild(list);
    }
    if (warnings.length) {
      card.appendChild(el('h3', { text: warnings.length + ' warning(s)' }));
      const list = el('ul', { class: 'muted' });
      warnings.forEach(function (w) { list.appendChild(el('li', { text: w })); });
      card.appendChild(list);
    }
    body.appendChild(card);
    if (derived.stats) {
      const stats = el('div', { class: 'card' });
      stats.appendChild(el('h3', { text: 'Plant' }));
      stats.appendChild(el('p', { class: 'muted', text: derived.stats.nodes + ' nodes · ' + derived.stats.spans + ' spans · ' + derived.stats.onts + ' ONT · ' + derived.stats.routeKm + ' km' }));
      stats.appendChild(el('p', { class: 'muted', text: 'Capacity: ' + derived.stats.capacity.onts + ' / ' + (derived.stats.capacity.theoreticalMaxOnts || '?') + ' ONTs, cascade 1:' + derived.stats.capacity.splitterCascade }));
      body.appendChild(stats);
    }
  }

  function renderAll() {
    renderCanvas();
    renderRight();
  }

  // ---------------------------------------------------------------- interaction

  function onNodeClick(node, event) {
    event.stopPropagation();
    if (state.tool === 'connect') {
      if (!state.connectFrom) { state.connectFrom = node.id; banner('Now click the far end of the cable.', 'ok'); return; }
      if (state.connectFrom === node.id) { state.connectFrom = null; banner(''); return; }
      const from = (state.project.nodes || []).find(function (n) { return n.id === state.connectFrom; });
      const to = node;
      const distance = (from && typeof from.lat === 'number' && typeof to.lat === 'number')
        ? Math.max(1, Math.round(GFScene.distanceM(from, to)))
        : 100;
      const cable = state.selectedCable || 'g652d-loose-12';
      api('/api/projects/' + state.project.id + '/ops', {
        method: 'POST',
        body: JSON.stringify({ op: 'add-span', span: { from: state.connectFrom, to: node.id, cable: cable, lengthM: distance } })
      }).then(function (project) {
        state.project = project; state.derived = project.derived; state.connectFrom = null;
        state.bom = null; state.strands = null; state.budget = null;
        banner(''); renderAll(); loadProjects();
      }).catch(function (err) { banner(err.message); });
      return;
    }
    state.selected = node.id;
    state.checks = null;
    renderCanvas();
    if (state.tab !== 'splice') { state.tab = 'splice'; syncTabs(); }
    renderRight();
  }

  function onCanvasClick(event) {
    if (state.tool === 'select' || state.tool === 'connect') { state.selected = null; renderCanvas(); return; }
    if (!state.project) return;
    const svg = $('#canvas');
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 900;
    const y = ((event.clientY - rect.top) / rect.height) * 560;
    const scene = state.lastScene || GFScene.project([], {});
    const point = GFScene.unproject(x, y, { scale: scene.scale, centre: scene.centre, width: 900, height: 560 });
    const type = state.tool;
    const model = type === 'closure' ? 'nap-8' : type === 'splitter' ? 'plc-1x8-sca' : type === 'ont' ? 'gpon-ont-1ge' : 'gpon-c-plus-8';
    api('/api/projects/' + state.project.id + '/ops', {
      method: 'POST',
      body: JSON.stringify({ op: 'add-node', node: { type: type, model: model, lat: point.lat, lon: point.lon, name: type.toUpperCase() } })
    }).then(function (project) {
      state.project = project; state.derived = project.derived;
      state.budget = null; state.checks = null;
      renderAll(); loadProjects();
    }).catch(function (err) { banner(err.message); });
  }

  function syncTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === state.tab);
    });
    document.querySelectorAll('.tool').forEach(function (tool) {
      tool.classList.toggle('active', tool.getAttribute('data-tool') === state.tool);
    });
  }

  function undo() {
    if (!state.project) return;
    api('/api/projects/' + state.project.id + '/undo', { method: 'POST', body: '{}' })
      .then(function (project) {
        state.project = project; state.derived = project.derived;
        state.budget = null; state.bom = null; state.strands = null; state.checks = null;
        renderAll(); loadProjects(); banner(project.undone ? 'Undid: ' + project.undone : 'Nothing to undo', 'ok');
      }).catch(function (err) { banner(err.message); });
  }

  function importKml(file) {
    const reader = new FileReader();
    reader.onload = function () {
      const isKmz = /\.kmz$/i.test(file.name);
      fetch('/api/import/kml', {
        method: 'POST',
        headers: { 'Content-Type': isKmz ? 'application/vnd.google-earth.kmz' : 'application/vnd.google-earth.kml+xml' },
        body: reader.result
      }).then(function (res) { return res.json(); }).then(function (result) {
        // A tuple the parser could not read is dropped and counted, never read as 0 - and the route
        // length in this sentence is measured on fewer bends because of it. Saying so here is the
        // difference between an import a planner can trust and one that quietly lost a corner.
        const lost = result.droppedCoordinates
          ? ' ' + result.droppedCoordinates + ' coordinate tuple(s) could not be read and were dropped.'
          : '';
        banner('Imported ' + result.routes.length + ' route(s), ' + result.points.length + ' point(s), ' +
          result.duplicates + ' duplicate(s) skipped, ' + result.routeM + ' m of route.' + lost,
          result.droppedCoordinates ? 'warn' : 'ok');
      }).catch(function (err) { banner('KML import failed: ' + err.message); });
    };
    if (/\.kmz$/i.test(file.name)) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  function printPlan() {
    if (!state.project) { banner('Open a project before printing'); return; }
    // The page is server-rendered HTML: the browser's own Print / Save as PDF is the whole export
    // path, so there is no PDF library and nothing to install on the machine that reads it.
    window.open('/print/project/' + encodeURIComponent(state.project.id), '_blank');
  }

  function exportPng() {
    if (!state.project || !state.lastScene) { banner('Open a project before exporting'); return; }
    let size;
    try {
      // exportPlan is the tested arithmetic: a 2x drawing means half the metres per pixel, and the
      // figure written on the PNG is the one the projection actually used.
      size = GFScene.exportPlan(
        { width: 900, height: 560, metresPerPixel: state.lastScene.metresPerPixel }, 2);
    } catch (err) {
      banner(err.message);
      return;
    }

    const drawing = $('#canvas').cloneNode(true);
    drawing.setAttribute('xmlns', GFDom.SVG_NS);
    drawing.setAttribute('width', size.width);
    drawing.setAttribute('height', size.height);
    // The canvas is transparent so the dark page shows through; a PNG on a white sheet needs its
    // own background, and the scale note has to survive the trip out of the browser.
    drawing.insertBefore(el('rect', { x: 0, y: 0, width: 900, height: 560, fill: '#0b0f13' }), drawing.firstChild);
    drawing.appendChild(el('text', { x: 18, y: 546, fill: '#93a1b0', 'font-size': '12', text: size.label }));

    const blob = new Blob([new XMLSerializer().serializeToString(drawing)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d').drawImage(image, 0, 0, size.width, size.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (png) {
        if (!png) { banner('PNG export failed: the browser produced no image'); return; }
        const link = document.createElement('a');
        const safeName = String(state.project.name || 'glassforge').replace(/[^a-z0-9._-]+/gi, '-');
        link.href = URL.createObjectURL(png);
        link.download = safeName + '-plan-' + size.width + 'x' + size.height + '.png';
        document.body.appendChild(link);
        link.click();
        // Keep the object URL alive until the download has started; revoking it and pulling the
        // anchor out of the document in the same tick cancels the save in some browsers.
        setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
        banner('Exported ' + size.width + ' \u00d7 ' + size.height + ' px \u2014 ' + size.label, 'ok');
      }, 'image/png');
    };
    image.onerror = function () {
      URL.revokeObjectURL(url);
      banner('PNG export failed: the drawing could not be rasterised');
    };
    image.src = url;
  }

  function bind() {
    document.querySelectorAll('.tool').forEach(function (tool) {
      tool.addEventListener('click', function () {
        state.tool = tool.getAttribute('data-tool');
        state.connectFrom = null;
        syncTabs();
        banner('');
      });
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        state.tab = tab.getAttribute('data-tab');
        syncTabs();
        renderRight();
      });
    });
    $('#canvas').addEventListener('click', onCanvasClick);
    $('#undo').addEventListener('click', undo);
    $('#new-project').addEventListener('click', newProject);
    $('#print-plan').addEventListener('click', printPlan);
    $('#export-png').addEventListener('click', exportPng);
    $('#auto-run').addEventListener('click', runAutoDesign);
    $('#network-file').addEventListener('change', function (event) {
      if (event.target.files && event.target.files[0]) importNetwork(event.target.files[0]);
    });
    $('#network-clear').addEventListener('click', function () {
      state.network = null;
      $('#network-status').textContent = 'network: none (straight-line x1.2)';
    });
    $('#kml-file').addEventListener('change', function (event) {
      if (event.target.files && event.target.files[0]) importKml(event.target.files[0]);
    });
    let searchTimer = null;
    $('#part-search').addEventListener('input', function (event) {
      clearTimeout(searchTimer);
      const term = event.target.value;
      searchTimer = setTimeout(function () { loadParts(term); }, 150);
    });
    $('#project-name').addEventListener('change', function (event) {
      if (!state.project) return;
      api('/api/projects/' + state.project.id, { method: 'PUT', body: JSON.stringify({ name: event.target.value }) })
        .then(function (project) { state.project = project; loadProjects(); })
        .catch(function (err) { banner(err.message); });
    });
  }

  function init() {
    bind();
    api('/api/health').then(function (health) { $('#version').textContent = 'v' + health.version; });
    loadParts('');
    loadProjects().then(function () {
      const last = localStorage.getItem('gf:lastProject');
      if (last) openProject(last).catch(function () { loadProjects(); });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
