/* Glassforge UI — no framework, no build step, no CDN. */
(function () {
  'use strict';

  const state = {
    registry: { counts: null, parts: {} },
    project: null,
    tool: 'select',
    connectFrom: null,
    selected: null,
    tab: 'signal',
    derived: null,
    budgets: null,
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
      state.budgets = null; state.bom = null; state.strands = null;
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
      const line = el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: '#3d4b5a', 'stroke-width': 2.5, 'stroke-linecap': 'round'
      });
      spansLayer.appendChild(line);
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

  function renderSignal(body) {
    if (!state.budgets) {
      body.appendChild(el('p', { class: 'muted', text: 'Loading budgets…' }));
      api('/api/projects/' + state.project.id + '/budget', { method: 'POST', body: JSON.stringify({}) })
        .then(function (payload) { state.budgets = payload.budgets; renderRight(); })
        .catch(function (err) { body.textContent = ''; body.appendChild(el('p', { class: 'err', text: err.message })); });
      return;
    }
    if (!state.budgets.length) { body.appendChild(el('p', { class: 'muted', text: 'No ONTs yet: place one to see a power budget.' })); return; }
    for (const entry of state.budgets) {
      const card = el('div', { class: 'card' });
      card.appendChild(el('h3', { text: entry.name || entry.ont }));
      if (entry.error) { card.appendChild(el('p', { class: 'err', text: entry.error })); body.appendChild(card); continue; }
      const r = entry.result;
      const verdict = el('span', { class: 'verdict ' + r.verdict, text: r.verdict.toUpperCase() });
      card.appendChild(verdict);
      const rows = [
        ['Rx power', r.rxPowerDbm + ' dBm'],
        ['Sensitivity', r.sensitivityDbm + ' dBm (overload ' + r.overloadDbm + ')'],
        ['Headroom', r.headroomDb + ' dB (margin ' + r.marginDb + ')'],
        ['ODN loss', r.odnLossDb + ' dB of ' + r.budgetDb + ' dB ' + r.pon + ' ' + r.oltClass],
        ['Class headroom', r.classHeadroomDb + ' dB'],
        ['Cascade', '1:' + r.cascadeRatio],
        ['Wavelength', r.wavelength + ' nm ' + r.direction + 'stream']
      ];
      const table = el('table', {});
      for (const row of rows) {
        const tr = el('tr', {});
        tr.appendChild(el('th', { text: row[0] }));
        tr.appendChild(el('td', { class: 'num', text: row[1] }));
        table.appendChild(tr);
      }
      card.appendChild(table);
      if (r.reasons.length) {
        const list = el('ul', { class: 'err' });
        for (const reason of r.reasons) list.appendChild(el('li', { text: reason }));
        card.appendChild(list);
      }
      const details = el('details', {});
      details.appendChild(el('summary', { class: 'muted', text: 'Loss breakdown' }));
      const inner = el('table', {});
      for (const line of r.breakdown) {
        const tr = el('tr', {});
        tr.appendChild(el('td', { text: line.label }));
        tr.appendChild(el('td', { class: 'num', text: line.db + ' dB' }));
        inner.appendChild(tr);
      }
      details.appendChild(inner);
      card.appendChild(details);
      body.appendChild(card);
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
      tr.appendChild(el('td', { class: 'num' + (row.overbooked ? ' err' : ''), text: String(row.used) }));
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
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: (splice.node.name || splice.node.id) + ' — thread diagram' }));
    card.appendChild(el('p', { class: 'muted', text: splice.spans.length + ' cables, ' + splice.rows.length + ' strands in use' }));
    const table = el('table', {});
    const head = el('tr', {});
    ['Span', 'Strand', 'Address', 'Colour'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    table.appendChild(head);
    for (const row of splice.rows) {
      const addr = GFFiber.addressFor(row.index, {});
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: row.span }));
      tr.appendChild(el('td', { class: 'num', text: String(row.index) }));
      tr.appendChild(el('td', { text: addr.label }));
      const td = el('td', {});
      const sw = el('span', { class: 'swatch' });
      sw.style.background = addr.fiberColor.hex;
      td.appendChild(sw);
      td.appendChild(el('span', { text: addr.fiberColor.name }));
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
    if (result.ok) {
      const apply = el('button', { text: 'Apply to this project' });
      apply.addEventListener('click', applyAutoDesign);
      card.appendChild(apply);
    }
    body.appendChild(card);

    const table = el('table', {});
    const head = el('tr', {});
    ['Topology', 'Feasible', 'Cable m', 'Fibre-m', 'ONT', 'SPL', 'Closure', 'Worst dB']
      .forEach(function (h) { head.appendChild(el('th', { text: h })); });
    table.appendChild(head);
    for (const candidate of result.candidates) {
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: candidate.label }));
      tr.appendChild(el('td', { text: candidate.feasible ? 'yes' : 'no' }));
      tr.appendChild(el('td', { class: 'num', text: String(candidate.metrics.cableM) }));
      tr.appendChild(el('td', { class: 'num', text: String(candidate.metrics.fibreMetres) }));
      tr.appendChild(el('td', { class: 'num', text: String(candidate.metrics.onts) }));
      tr.appendChild(el('td', { class: 'num', text: String(candidate.metrics.splitters) }));
      tr.appendChild(el('td', { class: 'num', text: String(candidate.metrics.closures) }));
      tr.appendChild(el('td', {
        class: 'num' + (candidate.feasible ? '' : ' err'),
        text: candidate.metrics.worstHeadroomDb === null ? '—' : String(candidate.metrics.worstHeadroomDb)
      }));
      table.appendChild(tr);
      if (!candidate.feasible) {
        const reason = el('tr', {});
        const cell = el('td', { class: 'err', colspan: '8', text: candidate.reasons[0] || 'infeasible' });
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
    return {
      demand: text,
      headEnd: { lat: lat, lon: lon, name: 'Head-end' },
      technology: $('#auto-tech').value
    };
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
        state.bom = null; state.strands = null; state.budgets = null;
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
      state.budgets = null; state.checks = null;
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
        state.budgets = null; state.bom = null; state.strands = null; state.checks = null;
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
        banner('Imported ' + result.routes.length + ' route(s), ' + result.points.length + ' point(s), ' +
          result.duplicates + ' duplicate(s) skipped, ' + result.routeM + ' m of route.', 'ok');
      }).catch(function (err) { banner('KML import failed: ' + err.message); });
    };
    if (/\.kmz$/i.test(file.name)) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
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
    $('#auto-run').addEventListener('click', runAutoDesign);
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
