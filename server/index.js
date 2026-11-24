'use strict';
/**
 * The HTTP surface: static UI, parts catalogue, projects, budgets, BOM and KML import.
 *
 * Zero dependencies, and that constraint is deliberate on both sides of the wire - no framework
 * here, no build step or CDN in `web/`. Anything this server needs, Node 18 already has.
 *
 * Two behaviours worth knowing:
 *
 * - `/api/parts` answers with `ETag` derived from the body it just serialised, plus gzip when the
 *   client offers it. An ETag taken from the clock instead revalidates nothing, so the catalogue is
 *   hashed and two consecutive requests are asserted to agree in `test/api-http.test.js`.
 * - every project write is validated against the engine before it lands. A saved design that the
 *   engine cannot budget is worse than a refused save, because it fails days later on site.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const engine = require('../engine');
const scene = require('../web/scene');
const store = require('./store');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const staticCache = new Map();

function etagOf(body) {
  return '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27) + '"';
}

function sendJson(req, res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value));
  const etag = etagOf(body);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': etag
  }, extraHeaders || {});

  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip && body.length > 512) {
    const gz = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }

  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * A refusal caused by what the client sent is a 400, not a 500.
 *
 * demand/design throw plain Errors and TypeErrors for bad input ("needs a header naming a latitude
 * column", "headEnd is required"); letting those reach the generic handler turned a helpful sentence
 * into "internal error" and told the caller the server was broken when their CSV was.
 */
function asBadRequest(err) {
  if (err && !err.status) err.status = 400;
  return err;
}

function fail(req, res, status, message, extra, headers) {
  sendJson(req, res, status, Object.assign({ error: message }, extra || {}), headers);
}

/**
 * Every endpoint this server has, and the methods it answers.
 *
 * The gate exists because the fallthrough could not tell two different mistakes apart:
 * `GET /api/design/synthesise` - a URL straight out of docs/API.md - came back as
 * `404 no such endpoint`, a caller sent hunting for a path that is right there; and the endpoints
 * whose handlers never looked at the method (`/api/health`, `/api/parts`, a single part) answered
 * `POST` with a 200, so a script that "worked" was calling a read as a write. A path that exists
 * with the wrong method is a 405 naming the methods it does answer, and `Allow` carries them.
 *
 * 404 keeps its own meaning: the path is not an endpoint at all. `HEAD` follows `GET`.
 */
const ENDPOINT_METHODS = [
  { pattern: /^\/api\/health$/, methods: ['GET'] },
  { pattern: /^\/api\/parts$/, methods: ['GET'] },
  { pattern: /^\/api\/parts\/[a-z]+\/[a-z0-9._-]+$/, methods: ['GET'] },
  { pattern: /^\/api\/projects$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+$/, methods: ['GET', 'PUT', 'DELETE'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+\/ops$/, methods: ['POST'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+\/undo$/, methods: ['POST'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+\/budget$/, methods: ['POST'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+\/bom$/, methods: ['GET'] },
  { pattern: /^\/api\/projects\/[a-z0-9-]+\/strands$/, methods: ['GET'] },
  { pattern: /^\/api\/design\/synthesise$/, methods: ['POST'] },
  { pattern: /^\/api\/design\/budget$/, methods: ['POST'] },
  { pattern: /^\/api\/design\/link$/, methods: ['POST'] },
  { pattern: /^\/api\/design\/length$/, methods: ['POST'] },
  { pattern: /^\/api\/design\/splitter$/, methods: ['GET'] },
  { pattern: /^\/api\/import\/network$/, methods: ['POST'] },
  { pattern: /^\/api\/import\/demand$/, methods: ['POST'] },
  { pattern: /^\/api\/import\/kml$/, methods: ['POST'] }
];

/** The methods an endpoint answers, or null when the path is not an endpoint at all. */
function allowedMethods(pathname) {
  for (const route of ENDPOINT_METHODS) {
    if (route.pattern.test(pathname)) {
      return route.methods.indexOf('GET') !== -1 ? route.methods.concat('HEAD') : route.methods.slice();
    }
  }
  return null;
}

function methodNotAllowed(req, res, pathname, methods) {
  const allow = methods.join(', ');
  return fail(req, res, 405,
    'method ' + req.method + ' is not allowed on ' + pathname + ' - it answers ' + allow,
    undefined, { Allow: allow });
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body exceeds ' + limit + ' bytes'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function describeJsonBody(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return 'a ' + typeof value;
}

async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit || MAX_BODY_BYTES);
  if (!buf.length) return {};
  let body;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw Object.assign(new Error('invalid JSON body: ' + err.message), { status: 400 });
  }
  // Every endpoint below reads a named field off the body. `null` is valid JSON and is what a client
  // sends when it has no object to send, and an array is what a caller posts when it mistakes the
  // body for the list it wants to send - neither has fields, so the first access threw a TypeError
  // and the generic handler answered 500 "Cannot read properties of null (reading 'demand')". That
  // told the caller the server broke when the request did. The body must be an object; say what
  // arrived, once, before any handler can misnarrate it.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('the request body must be a JSON object, got ' + describeJsonBody(body)),
      { status: 400 });
  }
  return body;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.indexOf('..') !== -1) return fail(req, res, 400, 'bad path');
  const file = path.join(WEB_DIR, rel);
  const ext = path.extname(file);
  if (!CONTENT_TYPES[ext]) return fail(req, res, 404, 'not found');

  let entry = staticCache.get(file);
  try {
    const stat = fs.statSync(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      const body = fs.readFileSync(file);
      entry = { body: body, mtimeMs: stat.mtimeMs, etag: etagOf(body), type: CONTENT_TYPES[ext] };
      staticCache.set(file, entry);
    }
  } catch (err) {
    return fail(req, res, 404, 'not found');
  }

  const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', 'ETag': entry.etag };
  const inm = req.headers['if-none-match'];
  if (inm && inm === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip && entry.body.length > 512) {
    const gz = zlib.gzipSync(entry.body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    res.end(gz);
    return;
  }
  headers['Content-Length'] = entry.body.length;
  res.writeHead(200, headers);
  res.end(entry.body);
}

function serveEngineFile(req, res, name) {
  // One engine file is shared with the browser verbatim: the TIA-598 colour table and the strand
  // addressing. Serving the engine's own copy is the only way to guarantee the UI and the splice
  // diagram cannot disagree about what "T03-F07" means.
  const file = path.join(__dirname, '..', 'engine', name);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    return fail(req, res, 404, 'not found');
  }
  const headers = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': etagOf(body)
  };
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

function cataloguePayload(registry, kind, term) {
  const counts = registry.counts();
  const partsOut = {};
  const kinds = kind ? [kind] : engine.parts.KINDS;
  for (const k of kinds) {
    if (engine.parts.KINDS.indexOf(k) === -1) throw Object.assign(new Error('unknown part kind "' + k + '"'), { status: 400 });
    partsOut[k] = registry.search(term, k);
  }
  return { counts: counts, parts: partsOut };
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  // `decodeURIComponent` throws URIError on a truncated or bogus escape (`%E0%A4%A`, `%zz`). That is
  // a path the caller mistyped, not a fault in this server, and the generic handler answered it with
  // `500 URI malformed` plus a stack trace - the one answer docs/API.md reserves for "the server
  // broke". Refuse it once, here, naming the path, before any route sees a half-decoded string.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (err) {
    return fail(req, res, 400, 'the request path is not valid percent-encoding: "' + url.pathname + '"');
  }
  const method = req.method || 'GET';
  const registry = ctx.registry;

  // The method gate runs before dispatch, so every endpoint below is reached with a method it
  // answers. The per-block 405s further down stay as the fallback for a route added to the handler
  // without an entry in ENDPOINT_METHODS - they cannot name `Allow`, which is why the table is the
  // authority and this is the default.
  const allowed = allowedMethods(pathname);
  if (allowed && allowed.indexOf(method === 'HEAD' ? 'GET' : method) === -1) {
    return methodNotAllowed(req, res, pathname, allowed);
  }

  if (pathname === '/api/health') {
    return sendJson(req, res, 200, {
      ok: true,
      name: 'glassforge',
      version: engine.version,
      parts: registry.counts(),
      projects: store.listProjects(ctx.dataRoot).length,
      uptimeS: Math.round(process.uptime())
    });
  }

  if (pathname === '/api/parts') {
    const kind = url.searchParams.get('kind');
    const term = url.searchParams.get('q') || '';
    return sendJson(req, res, 200, cataloguePayload(registry, kind || null, term));
  }

  const partMatch = /^\/api\/parts\/([a-z]+)\/([a-z0-9._-]+)$/.exec(pathname);
  if (partMatch) {
    if (!registry.has(partMatch[1], partMatch[2])) {
      return fail(req, res, 404, 'no ' + partMatch[1] + ' part with model "' + partMatch[2] + '"');
    }
    return sendJson(req, res, 200, registry.get(partMatch[1], partMatch[2]));
  }

  if (pathname === '/api/projects') {
    if (method === 'GET') return sendJson(req, res, 200, { projects: store.listProjects(ctx.dataRoot) });
    if (method === 'POST') {
      const body = await readJsonBody(req);
      // The name is the other field a create can get wrong that the caller then cannot see. An object
      // or an array used to be saved as-is (it is truthy and JSON-safe), and the printed plan - the
      // page a crew takes to site - titled itself "[object Object] - plan". Same refusal as a bad OLT
      // model: 400, naming the field, before anything is written.
      const nameFault = engine.network.nameProblem(body.name);
      if (nameFault) return fail(req, res, 400, nameFault);
      const project = engine.project.createProject(body.name || 'Untitled project', { id: store.newId() });
      // The OLT model is another field a create can get wrong that the caller then cannot see. An
      // unknown model used to be saved with a 201 (apply() refuses op-level faults only), and every
      // later edit was then refused for 'node "n1" uses unknown olt model ...' - the *next* op
      // blamed for a typo made in the first one. A write is validated before it lands, and the
      // refusal names the models that exist.
      if (body.olt && !registry.has('olt', body.olt)) {
        return fail(req, res, 400, 'no olt part with model "' + body.olt + '" - known: ' +
          registry.all('olt').map(function (part) { return part.model; }).join(', '));
      }
      if (body.olt) {
        const applied = engine.project.apply(project, { op: 'add-node', node: { type: 'olt', model: body.olt } });
        if (applied.error) return fail(req, res, 400, applied.error);
        applied.project.id = project.id;
        store.writeProject(applied.project, ctx.dataRoot);
        return sendJson(req, res, 201, applied.project);
      }
      store.writeProject(project, ctx.dataRoot);
      return sendJson(req, res, 201, project);
    }
    return fail(req, res, 405, 'method not allowed');
  }

  const projectMatch = /^\/api\/projects\/([a-z0-9-]+)(\/[a-z]+)?$/.exec(pathname);
  if (projectMatch) {
    const id = projectMatch[1];
    const action = projectMatch[2] || '';
    let project;
    try {
      project = store.readProject(id, ctx.dataRoot);
    } catch (err) {
      return fail(req, res, 404, err.message);
    }

    if (!action && method === 'GET') return sendJson(req, res, 200, withDerived(project, registry));
    if (!action && method === 'DELETE') return sendJson(req, res, 200, store.removeProject(id, ctx.dataRoot));

    if (!action && method === 'PUT') {
      const body = await readJsonBody(req);
      const candidate = Object.assign({}, project, body, { id: id });
      const check = engine.project.check(candidate, registry);
      if (!check.ok) return fail(req, res, 400, 'the design does not validate', { errors: check.errors });
      candidate.updatedAt = new Date().toISOString();
      store.writeProject(candidate, ctx.dataRoot);
      return sendJson(req, res, 200, withDerived(candidate, registry));
    }

    if (action === '/ops' && method === 'POST') {
      const body = await readJsonBody(req);
      const applied = engine.project.apply(project, body, {});
      if (applied.error) return fail(req, res, 400, applied.error);
      const candidate = applied.project;
      candidate.updatedAt = new Date().toISOString();
      const check = engine.project.check(candidate, registry);
      // An edit that leaves the plant invalid is refused here, for the same reason `PUT` refuses one:
      // the point of validating a write is that nothing un-budgetable reaches the disk. Returning 200
      // and letting `derived.errors` carry the objection made the check advisory — the caller has the
      // new project and no reason to read `derived`, so a span with an unknown cable model, or a PON
      // cascaded past its OLT's split limit, was saved and only failed days later on site. Both of
      // those are now 400s naming the span and the field. Warnings stay warnings and ride along on the
      // 200 (`warnings` below), because a 25 km span is a question, not a contradiction.
      if (!check.ok) {
        return fail(req, res, 400, 'the edit would leave the plant invalid: ' + check.errors.join('; '), {
          errors: check.errors,
          warnings: check.warnings
        });
      }
      store.writeProject(candidate, ctx.dataRoot);
      return sendJson(req, res, 200, Object.assign(withDerived(candidate, registry), { warnings: check.warnings }));
    }

    if (action === '/undo' && method === 'POST') {
      const undone = engine.project.undo(project);
      undone.project.id = id;
      undone.project.updatedAt = new Date().toISOString();
      store.writeProject(undone.project, ctx.dataRoot);
      return sendJson(req, res, 200, Object.assign(withDerived(undone.project, registry), { undone: undone.undone ? undone.undone.op : null }));
    }

    if (action === '/budget' && method === 'POST') {
      const body = await readJsonBody(req);
      // ontId is a node id: an id that names nothing, or names the OLT, is the caller's
      // mistake. designForOnt throws for both, and uncaught that becomes a 500 - "the server
      // broke" - when the answer is a 400 naming the id and the ONTs this plant actually has.
      if (body.ontId) {
        const nodes = project.nodes || [];
        const onts = nodes.filter(function (n) { return n && n.type === 'ont'; });
        const target = nodes.find(function (n) { return n && n.id === body.ontId; });
        if (!target) {
          return fail(req, res, 400, 'no node with id "' + body.ontId + '"' + (onts.length
            ? ' - this project has ONTs: ' + onts.map(function (n) { return n.id; }).join(', ')
            : ' - this project has no ONTs'));
        }
        if (target.type !== 'ont') {
          return fail(req, res, 400, 'node "' + body.ontId + '" has type "' + target.type +
            '", not "ont" - /budget takes an ONT id');
        }
      }
      // Both forms answer the same row (`{ ont, name, result }` or `{ ont, name, error }`, with
      // `ont` the node id): `ontId` is the whole plant's answer with one row in it, not a second
      // schema. The bare result it used to send carried the ONT *model* in `ont` and turned a path
      // that cannot be budgeted into a 500 the list call reports as an error row.
      const budgets = body.ontId
        ? [engine.network.budgetRow(project, body.ontId, registry, body)]
        : engine.network.allOntBudgets(project, registry, body);
      return sendJson(req, res, 200, { budgets: budgets });
    }

    if (action === '/bom' && method === 'GET') {
      // A project on disk can predate the save-time check, or be edited by hand, so a span may name
      // a cable the catalogue does not have. That plant cannot be priced - it is not a broken
      // server - so answer 400 naming the span instead of letting the lookup's throw become a 500.
      // Any other error still escapes as a 500: a real fault must not be dressed up as caller input.
      let bom;
      try {
        bom = engine.length.billOfMaterials(project, registry, {});
      } catch (err) {
        // The same read as the validator, naming the span. A file edited by hand never met the write
        // gate, and cableToBuy's own sentence ("splices must be a number or an array") tells the
        // caller the server broke when it was the file's field that is not a count.
        const unpriceable = (project.spans || []).map(function (span) {
          if (!span) return null;
          if (span.cable && !registry.has('cable', span.cable)) {
            return 'span "' + span.id + '" uses unknown cable model "' + span.cable + '"';
          }
          if (!engine.network.isSpanCount(span.splices)) {
            return 'span "' + span.id + '" has an invalid splices count "' + String(span.splices) + '"';
          }
          if (!engine.network.isSpanCount(span.closures)) {
            return 'span "' + span.id + '" has an invalid closures count "' + String(span.closures) + '"';
          }
          if (!engine.network.isBundleCount(span.bundles)) {
            return 'span "' + span.id + '" has an invalid bundles count "' + String(span.bundles) + '"';
          }
          return null;
        }).filter(function (problem) { return problem !== null; });
        if (!unpriceable.length) throw err;
        throw asBadRequest(new Error(unpriceable.join('; ')));
      }
      return sendJson(req, res, 200, bom);
    }

    if (action === '/strands' && method === 'GET') {
      return sendJson(req, res, 200, engine.network.strandLedger(project, registry));
    }

    // An action that is not in the table above is a sub-resource that does not exist: no method
    // makes `/api/projects/x/nope` work, and the old 405 ("method not allowed") implied one might.
    return fail(req, res, 404, 'no such endpoint: ' + pathname);
  }

  if (pathname === '/api/design/synthesise' && method === 'POST') {
    const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
    if (body.demand === undefined) return fail(req, res, 400, 'demand is required: a CSV string or an array of { lat, lon } rows');
    let result;
    try {
      result = engine.design.synthesise(body.demand, {
        headEnd: body.headEnd,
        technology: body.technology,
        routeFactor: body.routeFactor,
        marginDb: body.marginDb,
        network: body.network,
        maxSnapM: body.maxSnapM,
        joinToleranceM: body.joinToleranceM,
        pon: body.pon,
        active: body.active,
        costs: body.costs
      }, registry);
    } catch (err) {
      throw asBadRequest(err);
    }

    if (!body.applyToProject) return sendJson(req, res, 200, result);

    // Applying a design is a separate, explicit step: the caller asked for a design, and a design
    // that silently overwrote their project would be the worst kind of helpful.
    if (!result.ok) {
      return fail(req, res, 400, 'the design produced no feasible plant to apply', {
        candidates: result.candidates.map(function (c) {
          return { label: c.label, feasible: c.feasible, reasons: c.reasons };
        })
      });
    }
    let project;
    try {
      project = store.readProject(body.applyToProject, ctx.dataRoot);
    } catch (err) {
      return fail(req, res, 404, err.message);
    }
    const replaced = engine.project.replacePlant(project, result.plant, {});
    if (replaced.error) return fail(req, res, 400, replaced.error);
    const candidate = replaced.project;
    candidate.updatedAt = new Date().toISOString();
    const check = engine.project.check(candidate, registry);
    if (!check.ok) return fail(req, res, 400, 'the designed plant does not validate', { errors: check.errors });
    store.writeProject(candidate, ctx.dataRoot);
    return sendJson(req, res, 200, Object.assign(result, {
      applied: { projectId: candidate.id, nodes: candidate.nodes.length, spans: candidate.spans.length, warnings: check.warnings }
    }));
  }

  if (pathname === '/api/import/demand' && method === 'POST') {
    // Parse and report only: the caller sees which rows were rejected before anything is designed.
    const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
    const input = body.demand !== undefined ? body.demand : (body.csv !== undefined ? body.csv : body.text);
    if (input === undefined) return fail(req, res, 400, 'demand is required: a CSV string or an array of rows');
    let parsed;
    try {
      parsed = engine.demand.prepare(input, {});
    } catch (err) {
      throw asBadRequest(err);
    }
    return sendJson(req, res, 200, {
      points: parsed.points,
      rejected: parsed.rejected,
      duplicates: parsed.duplicates,
      meta: parsed.meta,
      bbox: parsed.bbox
    });
  }

  if (pathname === '/api/design/budget' && method === 'POST') {
    // The caller hands us a design, not a saved project: a design with no OLT model is their
    // mistake, so it is a 400 that names the field. Letting the engine's TypeError escape said
    // "internal error" and told the caller the server was broken when their request was.
    const body = await readJsonBody(req);
    let result;
    try {
      result = engine.budget.opticalBudget(body.design || body, registry);
    } catch (err) {
      throw asBadRequest(err);
    }
    return sendJson(req, res, 200, result);
  }

  if (pathname === '/api/design/link' && method === 'POST') {
    // A site-to-site circuit: two sites, an optic at each end, both legs routed along the supplied
    // duct graph. Refusals are 400s: a link without two sites is a caller error, not a server fault.
    const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
    try {
      return sendJson(req, res, 200, engine.link.design(body, registry));
    } catch (err) {
      throw asBadRequest(err);
    }
  }

  if (pathname === '/api/design/length' && method === 'POST') {
    const body = await readJsonBody(req);
    let result;
    try {
      result = Array.isArray(body.points)
        ? engine.length.cableToBuyForRoute(body.points, body)
        : engine.length.cableToBuy(body);
    } catch (err) {
      throw asBadRequest(err);
    }
    return sendJson(req, res, 200, result);
  }

  if (pathname === '/api/design/splitter') {
    // A split ratio is an integer division factor. `Number('')` is 0 and `Math.log10(0)` is
    // -Infinity, which JSON turns into `null`, so the old endpoint answered 200 with no loss
    // figure at all for ratio=0, ratio=abc and a bare `?ratio=`. A figure that cannot be
    // computed is refused by name, never returned as null.
    const raw = url.searchParams.get('ratio');
    const ratio = raw === null ? 8 : Number(raw);
    if (!Number.isInteger(ratio) || ratio < 2) {
      return fail(req, res, 400, 'ratio must be a whole split ratio of 2 or more (e.g. 8, 16, 32), got "' +
        (raw === null ? '' : raw) + '"');
    }
    const ideal = 10 * Math.log10(ratio);
    return sendJson(req, res, 200, { ratio: ratio, idealSplitLossDb: Math.round(ideal * 100) / 100 });
  }

  if (pathname === '/api/import/network' && method === 'POST') {
    // Street/duct geometry for the router. Accepts KML, KMZ or JSON edges, and answers with the graph
    // it built so the caller can see what it is about to design on - and hand it back unchanged.
    const buf = await readBody(req, MAX_UPLOAD_BYTES);
    const type = String(req.headers['content-type'] || '');
    const isKmz = /kmz/.test(type) || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50);
    const isJson = /json/.test(type);
    let input;
    if (isKmz) {
      // A zip we cannot read - no central directory, or no .kml inside it - is the uploader's file,
      // not a broken server. `/api/import/kml` already answers 400 for these bytes; leaving this
      // call outside a try sent the zip parser's sentence through the generic handler as a 500,
      // so one endpoint called the same upload "your mistake" and the other "the server broke".
      try {
        input = engine.kml.kmzToKml(buf);
      } catch (err) {
        throw asBadRequest(err);
      }
    } else if (isJson) {
      try {
        input = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        return fail(req, res, 400, 'invalid JSON body: ' + err.message);
      }
    } else input = buf.toString('utf8');

    let graph;
    try {
      graph = engine.street.buildGraph(input, {});
    } catch (err) {
      throw asBadRequest(err);
    }
    const edges = Array.from(graph.edges.values())
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; })
      .map(function (edge) {
        return { id: edge.id, lengthM: Math.round(edge.lengthM * 10) / 10, coords: edge.geometry };
      });
    return sendJson(req, res, 200, { stats: graph.stats(), edges: edges });
  }

  if (pathname === '/api/import/kml' && method === 'POST') {
    const buf = await readBody(req, MAX_UPLOAD_BYTES);
    const isKmz = /kmz/.test(String(req.headers['content-type'] || '')) ||
      (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50);
    // A file that is not KML is the uploader's mistake, and `/api/import/network` already says so
    // with a 400 for the same bytes. This endpoint answered 500, which reads as "the importer is
    // broken" - it is not, the file is.
    let parsed;
    let classified;
    try {
      parsed = isKmz ? engine.kml.parseKmz(buf) : engine.kml.parseKml(buf.toString('utf8'));
      classified = engine.kml.classify(parsed, {});
    } catch (err) {
      throw asBadRequest(err);
    }
    return sendJson(req, res, 200, Object.assign({ name: parsed.name, unsupported: parsed.unsupported }, classified));
  }

  if (pathname.startsWith('/api/')) return fail(req, res, 404, 'no such endpoint: ' + pathname);
  if (method !== 'GET' && method !== 'HEAD') return fail(req, res, 405, 'method not allowed');
  if (pathname.indexOf('/print/project/') === 0) {
    const id = pathname.slice('/print/project/'.length);
    let project;
    try {
      project = store.readProject(id, ctx.dataRoot);
    } catch (err) {
      const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Project not found</title></head>' +
        '<body><h1>Project not found</h1><p>' + escapeHtml(err.message) + '</p></body></html>';
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }
    return printPage(req, res, project, registry);
  }

  if (pathname === '/fiber.js') return serveEngineFile(req, res, 'fiber.js');
  return serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------- printed plan

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function metres(n) {
  return String(Number(Number(n).toFixed(1)));
}

function planSvg(project) {
  const width = 900, height = 560;
  const transform = scene.project(project.nodes || [], { width: width, height: height, pad: 46 });
  const placed = new Map(transform.nodes.map(function (n) { return [n.id, n]; }));
  const parts = [];

  parts.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff"/>');

  for (const span of project.spans || []) {
    const a = placed.get(span.from);
    const b = placed.get(span.to);
    if (!a || !b || !a.placed || !b.placed) continue;
    if (Array.isArray(span.route) && span.route.length > 2) {
      // A routed span is drawn along its street geometry, exactly as the canvas draws it.
      const points = scene.projectPoints(span.route, {
        width: width, height: height, scale: transform.scale, centre: transform.centre
      }).map(function (p) { return p.x + ',' + p.y; }).join(' ');
      parts.push('<polyline points="' + points + '" fill="none" stroke="#3d4b5a" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>');
    } else {
      parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" ' +
        'stroke="#3d4b5a" stroke-width="2.5" stroke-linecap="round"/>');
    }
    parts.push('<text x="' + ((a.x + b.x) / 2) + '" y="' + ((a.y + b.y) / 2 - 5) + '" fill="#4a5568" ' +
      'font-size="11" text-anchor="middle">' + escapeHtml(scene.spanLabel(span)) + '</text>');
  }

  for (const node of transform.nodes) {
    const radius = node.type === 'olt' ? 14 : node.type === 'splitter' ? 10 : node.type === 'ont' ? 8 : 11;
    parts.push('<circle cx="' + node.x + '" cy="' + node.y + '" r="' + radius + '" fill="' +
      scene.nodeColour(node) + '" stroke="#0b0f13" stroke-width="1.5"/>');
    parts.push('<text x="' + node.x + '" y="' + (node.y + radius + 14) + '" fill="#1a202c" font-size="11" ' +
      'text-anchor="middle">' + escapeHtml(scene.nodeLabel(node)) + '</text>');
  }

  // The scale bar is the difference between a plan and a picture. A projection with no scale would
  // make the bar meaningless, so it is only drawn when project() produced a metresPerPixel.
  let scaleText = 'scale unavailable: no placed nodes';
  if (transform.metresPerPixel) {
    const bar = scene.scaleBar(transform.metresPerPixel, 160);
    const x = 28, y = 524;
    parts.push('<line x1="' + x + '" y1="' + y + '" x2="' + (x + bar.pixels) + '" y2="' + y +
      '" stroke="#1a202c" stroke-width="3"/>');
    parts.push('<line x1="' + x + '" y1="' + (y - 6) + '" x2="' + x + '" y2="' + (y + 6) + '" stroke="#1a202c" stroke-width="3"/>');
    parts.push('<line x1="' + (x + bar.pixels) + '" y1="' + (y - 6) + '" x2="' + (x + bar.pixels) + '" y2="' + (y + 6) +
      '" stroke="#1a202c" stroke-width="3"/>');
    parts.push('<text x="' + x + '" y="' + (y - 10) + '" fill="#1a202c" font-size="12">' + escapeHtml(bar.label) + '</text>');
    scaleText = '1 px = ' + metres(transform.metresPerPixel) + ' m on this drawing (scale bar: ' + bar.label + ')';
  }

  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" ' +
      'width="100%" role="img" aria-label="Plan of ' + escapeHtml(project.name || project.id) + '">' +
      parts.join('') + '</svg>',
    scaleText: scaleText
  };
}

function tableHtml(headers, rows, opts) {
  const o = opts || {};
  const head = '<thead><tr>' + headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead>';
  const body = rows.length
    ? rows.map(function (row) {
      return '<tr>' + row.map(function (cell) {
        const c = cell && typeof cell === 'object' ? cell : { text: cell };
        return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + (c.html !== undefined ? c.html : escapeHtml(c.text)) + '</td>';
      }).join('') + '</tr>';
    }).join('')
    : '<tr><td colspan="' + headers.length + '" class="muted">' + escapeHtml(o.empty || 'nothing to show') + '</td></tr>';
  return '<table>' + head + '<tbody>' + body + '</tbody></table>';
}

/**
 * What the splice sheet says a strand is joined to.
 *
 * A closure joins strand to strand (`splicedTo`), a strand on one cable is parked, and a splitter
 * neither: its input strand terminates on the splitter and its output strands leave from numbered
 * ports. Printing a span id for a splitter row would send a crew splicing the PON port straight to a
 * customer and past the split.
 */
function spliceTarget(row, point) {
  if (row.via === 'splitter-input') {
    return point.termination === 'connectorised' ? 'splitter input (2 connectors)' : 'splitter input (1 splice)';
  }
  if (row.via === 'splitter-port') return 'splitter port P' + row.port;
  return row.splicedTo.length ? row.splicedTo.join(', ') : 'parked';
}

function printPage(req, res, project, registry) {
  const stats = engine.network.stats(project, registry);
  const check = engine.project.check(project, registry);
  const plan = planSvg(project);
  const root = (project.nodes || []).find(function (n) { return n.type === 'olt' || n.type === 'headend'; });
  const technology = root ? (root.type === 'olt' ? 'PON' : 'active') : 'no head-end';

  let bom = null, bomError = null;
  try {
    bom = engine.length.billOfMaterials(project, registry, {});
  } catch (err) {
    bomError = err.message;
  }

  const splice = engine.network.spliceTable(project, registry);

  const meta = [
    'project ' + (project.id || '?'),
    technology + (root && root.model ? ' (' + root.model + ')' : ''),
    stats.nodes + ' node(s)',
    stats.spans + ' span(s)',
    metres(stats.routeM) + ' m of route',
    stats.onts + ' ONT(s)'
  ].join(' \u00b7 ');

  const out = [];
  out.push('<!DOCTYPE html>');
  out.push('<html lang="en"><head><meta charset="utf-8">');
  out.push('<title>' + escapeHtml(project.name || project.id) + ' \u2014 plan</title>');
  out.push('<style>' +
    'body{font:12px/1.45 "Helvetica Neue",Arial,sans-serif;color:#111;background:#fff;margin:0;padding:24px;max-width:1000px}' +
    'h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}' +
    'h3{font-size:13px;margin:14px 0 4px}.meta{color:#444;margin:0 0 12px}' +
    '.muted{color:#666}table{border-collapse:collapse;width:100%;margin:4px 0 12px}' +
    'th,td{border:1px solid #999;padding:3px 6px;text-align:left;vertical-align:top}' +
    'th{background:#eee;font-weight:600}.num{text-align:right}.err{color:#a00}.warn{color:#8a5a00}' +
    '.swatch{display:inline-block;width:10px;height:10px;border:1px solid #333;margin-right:4px;vertical-align:middle}' +
    '.drawing{border:1px solid #999}footer{margin-top:18px;color:#666;font-size:10px}' +
    '@page{margin:14mm}@media print{body{padding:0;max-width:none}thead{display:table-header-group}' +
    'tr{page-break-inside:avoid}h2{page-break-after:avoid}.drawing{page-break-inside:avoid}}' +
    '</style></head><body>');

  out.push('<h1>' + escapeHtml(project.name || project.id) + '</h1>');
  out.push('<p class="meta">' + escapeHtml(meta) + '</p>');
  out.push('<div class="drawing">' + plan.svg + '</div>');
  out.push('<p class="muted">' + escapeHtml(plan.scaleText) + '</p>');

  // The budget's warnings are the plan's warnings, not a separate page. `project.check` is
  // structural - it never runs an optical budget - so a link that is clean only at the bottom of
  // its launch window (#111) printed as "No errors and no warnings" while the Signal tab said
  // nothing either. A plan is signed off from this page, so the band has to be on it.
  const signalWarnings = [];
  let budgetRows = [];
  try {
    budgetRows = engine.network.allOntBudgets(project, registry, {});
  } catch (err) {
    signalWarnings.push('the optical budget could not be run: ' + err.message);
  }
  for (const row of budgetRows) {
    if (!row.result) continue;
    const label = row.name || row.ont;
    (row.result.warnings || []).forEach(function (w) {
      signalWarnings.push(label + ': ' + w);
    });
  }

  out.push('<h2>Checks</h2>');
  const planWarnings = check.warnings.concat(signalWarnings);
  if (!check.errors.length && !planWarnings.length) {
    out.push('<p class="muted">No errors and no warnings.</p>');
  } else {
    if (check.errors.length) {
      out.push('<ul class="err">' + check.errors.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>');
    }
    if (planWarnings.length) {
      out.push('<ul class="warn">' + planWarnings.map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join('') + '</ul>');
    }
  }

  out.push('<h2>Cable to buy</h2>');
  if (bomError) {
    out.push('<p class="err">Cable to buy unavailable: ' + escapeHtml(bomError) + '</p>');
  } else if (!bom.byCable.length) {
    out.push('<p class="muted">This project has no spans, so there is no cable to buy.</p>');
  } else {
    out.push(tableHtml(['Cable', 'Fibres', 'Design m', 'Drums', 'Buy m', 'Spare m'], bom.byCable.map(function (row) {
      return [row.model, { text: String(row.fiberCount), cls: 'num' }, { text: metres(row.designM), cls: 'num' },
        { text: String(row.drums), cls: 'num' }, { text: metres(row.purchaseM), cls: 'num' },
        { text: metres(row.spareM), cls: 'num' }];
    })));
    out.push('<h3>Per span</h3>');
    // Metres only: drums are rounded once per cable model, on the table above, so a drum count printed
    // here would contradict it (two short runs of one cable would each claim a drum of their own).
    out.push(tableHtml(['Span', 'From', 'To', 'Cable', 'Route m', 'Design m'], bom.lines.map(function (line) {
      return [line.span, line.from, line.to, line.cable, { text: metres(line.routeM), cls: 'num' },
        { text: metres(line.designM), cls: 'num' }];
    })));
  }

  out.push('<h2>Splice schedule</h2>');
  if (!splice.points.length) {
    out.push('<p class="muted">No closure or splitter carries assigned strands yet.</p>');
  } else {
    for (const point of splice.points) {
      out.push('<h3>' + escapeHtml(point.name) + ' <span class="muted">(' + escapeHtml(point.type) +
        (point.ratio ? ' 1:' + point.ratio : '') + ', ' +
        point.spans.length + ' cable(s), ' + point.rows.length + ' strand(s))</span></h3>');
      out.push(tableHtml(['Span', 'Strand', 'Address', 'Colour', 'Joints / port'], point.rows.map(function (row) {
        return [row.span, { text: String(row.strand), cls: 'num' }, row.address,
          { html: '<span class="swatch" style="background:' + escapeHtml(row.hex) + '"></span>' + escapeHtml(row.colour) },
          spliceTarget(row, point)];
      })));
    }
  }

  out.push('<footer>Generated by Glassforge ' + escapeHtml(engine.version) + ' on ' +
    new Date().toISOString().slice(0, 10) + '. A plan is only as good as the measured lengths it carries.</footer>');
  out.push('</body></html>');

  const html = out.join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html)
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function withDerived(project, registry) {
  const check = engine.project.check(project, registry);
  return Object.assign({}, project, {
    derived: {
      summary: engine.project.summary(project, registry),
      stats: engine.network.stats(project, registry),
      errors: check.errors,
      warnings: check.warnings
    }
  });
}

function createServer(opts) {
  const o = opts || {};
  const ctx = {
    registry: o.registry || engine.createRegistry(o.partsDir),
    dataRoot: o.dataRoot || store.dataDir()
  };

  const server = http.createServer(function (req, res) {
    handle(req, res, ctx).catch(function (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('glassforge: ' + (err && err.stack ? err.stack : err));
      fail(req, res, status, err && err.message ? err.message : 'internal error');
    });
  });

  server.registry = ctx.registry;
  server.dataRoot = ctx.dataRoot;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({});
  const health = server.registry.validate();
  if (!health.ok) {
    console.error('glassforge: the parts catalogue does not validate — fix these before serving:');
    for (const problem of health.problems) {
      console.error('  parts/' + (problem.kind || '?') + '/' + (problem.model || '?') + ': ' + (problem.errors || []).join('; '));
    }
    process.exitCode = 1;
  }
  server.listen(port, host, function () {
    const counts = server.registry.counts();
    console.log('glassforge ' + engine.version + ' on http://' + host + ':' + port +
      ' — ' + counts.total + ' parts (' + counts.byKind.cable + ' cables, ' + counts.byKind.splitter + ' splitters, ' +
      counts.byKind.olt + ' OLTs, ' + counts.byKind.ont + ' ONTs)');
  });
  const shutdown = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer: createServer, handle: handle };
