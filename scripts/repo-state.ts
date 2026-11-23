/**
 * One call that answers "what state is the repository in".
 *
 * Before this existed, answering that took four to six calls (git status, git log, git ls-remote, the
 * pull-request list, the issue list, the branch list), and one of them could lie: `git ls-remote` will
 * happily report a branch that does not exist yet while a push is still landing, whereas the forge API
 * is the record. A lane reported "PR #14 open and mergeable" and a concurrent ls-remote disagreed;
 * the API was right. So this reads the API, not the remote.
 *
 *   node scripts/repo-state.js              # human-readable
 *   node scripts/repo-state.js --json       # machine-readable
 *
 * Token: GLASSFORGE_TOKEN_FILE, defaulting to the Hermes secrets path. Never printed.
 */
import * as fs from 'node:fs';

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

const API = process.env.GLASSFORGE_API || 'http://odin:3000/api/v1/repos/jaylouisw/glassforge';
const TOKEN_FILE = process.env.GLASSFORGE_TOKEN_FILE ||
  'C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token';

function token(): string {
  const value = fs.readFileSync(TOKEN_FILE, 'utf8').replace(/[\r\n]/g, '');
  if (!value) throw new Error('token file ' + TOKEN_FILE + ' is empty');
  return value;
}

async function get<T>(path: string, auth: string): Promise<T> {
  const response = await fetch(API + path, { headers: { Authorization: 'token ' + auth } });
  if (!response.ok) throw new Error(path + ' -> HTTP ' + response.status);
  return (await response.json()) as T;
}

interface RawStatus {
  state?: string;
  statuses?: Array<{ context?: string; status?: string }> | null;
}

async function checksFor(sha: string, auth: string): Promise<CheckSummary[]> {
  if (!sha) return [];
  const status = await get<RawStatus>('/commits/' + sha + '/status', auth);
  return (status.statuses || []).map((entry) => ({
    context: (entry.context || '').replace(' (pull_request)', ''),
    status: entry.status || 'unknown'
  }));
}

async function collect(): Promise<RepoState> {
  const auth = token();
  const warnings: string[] = [];
  const repoName = API.replace(/^.*\/repos\//, '');

  let main: RepoRef | null = null;
  try {
    const branch = await get<{ commit?: { id?: string; message?: string } }>('/branches/main', auth);
    main = {
      label: (branch.commit?.message || '').split('\n')[0],
      ref: 'main',
      sha: branch.commit?.id || ''
    };
  } catch (error) {
    warnings.push('could not read main: ' + (error instanceof Error ? error.message : String(error)));
  }

  const rawPulls = await get<Array<Record<string, unknown>>>('/pulls?state=open&limit=50', auth);
  const pulls: PullSummary[] = [];
  for (const raw of rawPulls) {
    const head = (raw.head || {}) as { ref?: string; sha?: string };
    const sha = head.sha || '';
    pulls.push({
      number: Number(raw.number),
      title: String(raw.title || ''),
      branch: head.ref || '',
      sha: sha,
      mergeable: raw.mergeable === true,
      draft: raw.draft === true,
      checks: await checksFor(sha, auth)
    });
  }

  const rawIssues = await get<Array<Record<string, unknown>>>('/issues?state=open&type=issues&limit=50', auth);
  const issues = rawIssues.map((raw) => ({
    number: Number(raw.number),
    title: String(raw.title || ''),
    labels: ((raw.labels || []) as Array<{ name?: string }>).map((label) => label.name || '')
  }));

  // Two open pull requests on one commit is a duplicate that only surfaces at merge time.
  const bySha = new Map<string, number[]>();
  for (const pull of pulls) {
    if (!pull.sha) continue;
    bySha.set(pull.sha, [...(bySha.get(pull.sha) || []), pull.number]);
  }
  const duplicates = [...bySha.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([sha, numbers]) => numbers.map((n) => '#' + n).join(' and ') + ' share head commit ' + sha.slice(0, 10));

  return { repo: repoName, main: main, pulls: pulls, issues: issues, duplicates: duplicates, warnings: warnings };
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

async function main(): Promise<void> {
  const state = await collect();
  if (process.argv.includes('--json')) console.log(JSON.stringify(state, null, 2));
  else print(state);
  if (state.warnings.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('repo-state failed: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
