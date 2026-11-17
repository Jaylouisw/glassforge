'use strict';
/**
 * Project persistence: one JSON file per project under `GF_DATA` (default `data/`).
 *
 * The directory is user work, not source, so it is gitignored. Writes go through a temp file and a
 * rename, because a half-written JSON file is a project the user cannot open - and the app is a
 * planner, so the design in that file may be a week of survey.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const ID_RE = /^[a-z0-9-]{4,64}$/;

function dataDir() {
  return process.env.GF_DATA || DEFAULT_DATA_DIR;
}

function projectsDir(root) {
  return path.join(root || dataDir(), 'projects');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeId(id) {
  const s = String(id || '');
  if (!ID_RE.test(s)) throw new Error('invalid project id "' + s + '"');
  return s;
}

function newId() {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return 'p' + stamp + rand;
}

function projectPath(id, root) {
  return path.join(projectsDir(root), safeId(id) + '.json');
}

function listProjects(root) {
  const dir = projectsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      out.push({
        id: parsed.id,
        name: parsed.name,
        updatedAt: parsed.updatedAt,
        nodes: (parsed.nodes || []).length,
        spans: (parsed.spans || []).length,
        onts: (parsed.nodes || []).filter(function (n) { return n.type === 'ont'; }).length
      });
    } catch (err) {
      out.push({ id: file.replace(/\.json$/, ''), name: '(unreadable) ' + file, error: err.message });
    }
  }
  return out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
}

function readProject(id, root) {
  const file = projectPath(id, root);
  if (!fs.existsSync(file)) {
    const err = new Error('no project with id "' + id + '"');
    err.code = 'ENOENT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeProject(project, root) {
  if (!project || !project.id) throw new Error('project.id is required before saving');
  const file = projectPath(project.id, root);
  ensureDir(projectsDir(root));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return project;
}

function removeProject(id, root) {
  const file = projectPath(id, root);
  if (!fs.existsSync(file)) {
    const err = new Error('no project with id "' + id + '"');
    err.code = 'ENOENT';
    throw err;
  }
  fs.unlinkSync(file);
  return { id: id, removed: true };
}

module.exports = {
  DEFAULT_DATA_DIR: DEFAULT_DATA_DIR,
  dataDir: dataDir,
  projectsDir: projectsDir,
  newId: newId,
  safeId: safeId,
  listProjects: listProjects,
  readProject: readProject,
  writeProject: writeProject,
  removeProject: removeProject
};
