/**
 * One call that answers "what state is the repository in".
 *
 * Before this existed, answering that took four to six calls (git status, git log, git ls-remote, the
 * pull-request list, the issue list, the branch list), and one of them could lie: `git ls-remote` will
 * happily report a branch that does not exist yet while a push is still landing, whereas the forge API
 * is the record. A lane reported "PR #14 open and mergeable" and a concurrent ls-remote disagreed;
 * the API was right. So this reads the API, not the remote.
 *
 * The repository moved from a self-hosted Forgejo to GitHub, so the reads now go through `gh api`
 * (already installed and authenticated as the operator). This file holds no token, reads no token file
 * and prints no credential: `gh` owns the authentication, exactly as it does for `gh pr`/`gh issue`.
 *
 *   node scripts/repo-state.js              # human-readable
 *   node scripts/repo-state.js --json       # machine-readable
 *
 * Env overrides: GLASSFORGE_REPO (owner/name), GLASSFORGE_MAIN (base branch), GLASSFORGE_GH (binary).
 */
import { execFileSync } from 'node:child_process';

interface RepoRef {
  label: string;
  ref: string;
  sha: string;
}

interface PullSummary {
  number: number;
  title: string;
  branch: string;
  sha: string;
  mergeable: boolean;
  draft: boolean;
  checks: CheckSummary[];
}

interface CheckSummary {
  context: string;
  status: string;
}

interface IssueSummary {
  number: number;
  title: string;
  labels: string[];
}

interface RepoState {
  repo: string;
  main: RepoRef | null;
  pulls: PullSummary[];
  issues: IssueSummary[];
  duplicates: string[];
  warnings: string[];
}

const REPO = process.env.GLASSFORGE_REPO || 'jaylouisw/glassforge';
const MAIN_BRANCH = process.env.GLASSFORGE_MAIN || 'main';
const GH = process.env.GLASSFORGE_GH || 'gh';
const MAX_BUFFER = 32 * 1024 * 1024;
const PAGE = 100;

/** Run `gh` and return its stdout, turning a non-zero exit into one readable line. */
function gh(args: string[]): string {
  try {
    return execFileSync(GH, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error: unknown) {
    const record = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
    const fallback = typeof record.message === 'string' ? record.message : String(error);
    throw new Error('gh ' + args.join(' ') + ' failed: ' + (stderr || fallback));
  }
}

function parseJson(source: string): unknown {
  return JSON.parse(source) as unknown;
}

/** One request, already complete (a single object or a short list). */
function ghJson(path: string): unknown {
  return parseJson(gh(['api', '--method', 'GET', path]));
}

/**
 * Every page of a list endpoint, flattened.
 *
 * `--paginate` prints one JSON document per page and `--slurp` wraps those documents in an array, so
 * the result here is the concatenation of the pages. Without the slurp, two pages of JSON would be
 * pasted together and JSON.parse would fail on the boundary.
 */
function ghPages(path: string): unknown[] {
  const joined = path.includes('?') ? path + '&per_page=' + PAGE : path + '?per_page=' + PAGE;
  const pages = list(parseJson(gh(['api', '--method', 'GET', '--paginate', '--slurp', joined])));
  const rows: unknown[] = [];
  for (const page of pages) rows.push(...list(page));
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return list(value).filter(isRecord);
}

/**
 * Map a GitHub check run onto the vocabulary the old Forgejo statuses used, so the printed summary and
 * the JSON shape stay identical: success / pending / failure / error.
 */
function checkRunStatus(run: Record<string, unknown>): string {
  if (text(field(run, 'status')) !== 'completed') return 'pending';
  switch (text(field(run, 'conclusion'))) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    default:
      return text(field(run, 'conclusion')) || 'unknown';
  }
}

/**
 * Per-check state for a commit: GitHub splits this over two endpoints (check runs for Actions, commit
 * statuses for everything else), and a commit with no CI configured simply has neither.
 */
function checksFor(sha: string): CheckSummary[] {
  if (!sha) return [];
  const checks: CheckSummary[] = [];
  const seen = new Set<string>();

  const runPage = ghJson('repos/' + REPO + '/commits/' + sha + '/check-runs?per_page=' + PAGE);
  for (const run of records(field(runPage, 'check_runs'))) {
    const context = text(field(run, 'name')).replace(' (pull_request)', '').trim();
    if (!context || seen.has(context)) continue;
    seen.add(context);
    checks.push({ context: context, status: checkRunStatus(run) });
  }

  const statuses = records(field(ghJson('repos/' + REPO + '/commits/' + sha + '/status'), 'statuses'));
  for (const entry of statuses) {
    const context = text(field(entry, 'context')).replace(' (pull_request)', '').trim();
    if (!context || seen.has(context)) continue;
    seen.add(context);
    checks.push({ context: context, status: text(field(entry, 'state'), 'unknown') });
  }

  return checks;
}

/** `mergeable` is null on GitHub until the merge is computed; a single-PR read forces the answer. */
function mergeableFor(pull: Record<string, unknown>): boolean {
  const mergeable = field(pull, 'mergeable');
  if (typeof mergeable === 'boolean') return mergeable;
  const detail = ghJson('repos/' + REPO + '/pulls/' + number(field(pull, 'number')));
  return field(detail, 'mergeable') === true;
}

function collect(): RepoState {
  const warnings: string[] = [];

  let main: RepoRef | null = null;
  try {
    const branch = ghJson('repos/' + REPO + '/branches/' + MAIN_BRANCH);
    main = {
      label: text(field(field(field(branch, 'commit'), 'commit'), 'message')).split('\n')[0],
      ref: MAIN_BRANCH,
      sha: text(field(field(branch, 'commit'), 'sha'))
    };
  } catch (error: unknown) {
    warnings.push('could not read ' + MAIN_BRANCH + ': ' + (error instanceof Error ? error.message : String(error)));
  }

  const pulls: PullSummary[] = [];
  for (const raw of ghPages('repos/' + REPO + '/pulls?state=open')) {
    const full = isRecord(raw) ? raw : {};
    const head = field(full, 'head');
    const sha = text(field(head, 'sha'));
    let mergeable = false;
    try {
      mergeable = mergeableFor(full);
    } catch (error: unknown) {
      warnings.push('could not read mergeable for #' + number(field(full, 'number')) + ': ' +
        (error instanceof Error ? error.message : String(error)));
    }
    pulls.push({
      number: number(field(full, 'number')),
      title: text(field(full, 'title')),
      branch: text(field(head, 'ref')),
      sha: sha,
      mergeable: mergeable,
      draft: field(full, 'draft') === true,
      checks: checksFor(sha)
    });
  }

  const issues: IssueSummary[] = [];
  for (const raw of ghPages('repos/' + REPO + '/issues?state=open')) {
    if (!isRecord(raw)) continue;
    // The issues endpoint also returns pull requests; anything with `pull_request` is already above.
    if (field(raw, 'pull_request') !== undefined) continue;
    issues.push({
      number: number(field(raw, 'number')),
      title: text(field(raw, 'title')),
      labels: records(field(raw, 'labels')).map((label) => text(field(label, 'name')))
    });
  }

  // Two open pull requests on one commit is a duplicate that only surfaces at merge time.
  const bySha = new Map<string, number[]>();
  for (const pull of pulls) {
    if (!pull.sha) continue;
    bySha.set(pull.sha, [...(bySha.get(pull.sha) || []), pull.number]);
  }
  const duplicates = [...bySha.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([sha, numbers]) => numbers.map((n) => '#' + n).join(' and ') + ' share head commit ' + sha.slice(0, 10));

  return { repo: REPO, main: main, pulls: pulls, issues: issues, duplicates: duplicates, warnings: warnings };
}

function summariseChecks(checks: CheckSummary[]): string {
  if (!checks.length) return 'no checks';
  const failed = checks.filter((check) => check.status === 'failure' || check.status === 'error');
  const pending = checks.filter((check) => check.status === 'pending');
  if (failed.length) return failed.length + '/' + checks.length + ' FAILED (' + failed.map((c) => c.context).join(', ') + ')';
  if (pending.length) return pending.length + '/' + checks.length + ' pending';
  return checks.length + '/' + checks.length + ' green';
}

function print(state: RepoState): void {
  console.log(state.repo);
  if (state.main) console.log('  main   ' + state.main.sha.slice(0, 10) + '  ' + state.main.label);
  else console.log('  main   (unreadable)');

  console.log('  pulls  ' + state.pulls.length);
  for (const pull of state.pulls) {
    console.log('    #' + pull.number + '  ' + summariseChecks(pull.checks) +
      (pull.mergeable ? '  mergeable' : '  NOT mergeable') +
      (pull.draft ? '  draft' : '') +
      '  ' + pull.branch + ' @ ' + pull.sha.slice(0, 10));
    console.log('        ' + pull.title);
  }

  console.log('  issues ' + state.issues.length);
  for (const issue of state.issues) {
    console.log('    #' + issue.number + '  [' + (issue.labels.join(', ') || 'unlabelled') + ']  ' + issue.title);
  }

  for (const duplicate of state.duplicates) console.log('  DUPLICATE  ' + duplicate);
  for (const warning of state.warnings) console.log('  WARNING    ' + warning);
}

function main(): void {
  const state = collect();
  if (process.argv.includes('--json')) console.log(JSON.stringify(state, null, 2));
  else print(state);
  if (state.warnings.length) process.exitCode = 1;
}

try {
  main();
} catch (error: unknown) {
  console.error('repo-state failed: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
