"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const fs = require("node:fs");
const API = process.env.GLASSFORGE_API || 'http://odin:3000/api/v1/repos/jaylouisw/glassforge';
const TOKEN_FILE = process.env.GLASSFORGE_TOKEN_FILE ||
    'C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token';
function token() {
    const value = fs.readFileSync(TOKEN_FILE, 'utf8').replace(/[\r\n]/g, '');
    if (!value)
        throw new Error('token file ' + TOKEN_FILE + ' is empty');
    return value;
}
async function get(path, auth) {
    const response = await fetch(API + path, { headers: { Authorization: 'token ' + auth } });
    if (!response.ok)
        throw new Error(path + ' -> HTTP ' + response.status);
    return (await response.json());
}
async function checksFor(sha, auth) {
    if (!sha)
        return [];
    const status = await get('/commits/' + sha + '/status', auth);
    return (status.statuses || []).map((entry) => ({
        context: (entry.context || '').replace(' (pull_request)', ''),
        status: entry.status || 'unknown'
    }));
}
async function collect() {
    const auth = token();
    const warnings = [];
    const repoName = API.replace(/^.*\/repos\//, '');
    let main = null;
    try {
        const branch = await get('/branches/main', auth);
        main = {
            label: (branch.commit?.message || '').split('\n')[0],
            ref: 'main',
            sha: branch.commit?.id || ''
        };
    }
    catch (error) {
        warnings.push('could not read main: ' + (error instanceof Error ? error.message : String(error)));
    }
    const rawPulls = await get('/pulls?state=open&limit=50', auth);
    const pulls = [];
    for (const raw of rawPulls) {
        const head = (raw.head || {});
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
    const rawIssues = await get('/issues?state=open&type=issues&limit=50', auth);
    const issues = rawIssues.map((raw) => ({
        number: Number(raw.number),
        title: String(raw.title || ''),
        labels: (raw.labels || []).map((label) => label.name || '')
    }));
    // Two open pull requests on one commit is a duplicate that only surfaces at merge time.
    const bySha = new Map();
    for (const pull of pulls) {
        if (!pull.sha)
            continue;
        bySha.set(pull.sha, [...(bySha.get(pull.sha) || []), pull.number]);
    }
    const duplicates = [...bySha.entries()]
        .filter(([, numbers]) => numbers.length > 1)
        .map(([sha, numbers]) => numbers.map((n) => '#' + n).join(' and ') + ' share head commit ' + sha.slice(0, 10));
    return { repo: repoName, main: main, pulls: pulls, issues: issues, duplicates: duplicates, warnings: warnings };
}
function summariseChecks(checks) {
    if (!checks.length)
        return 'no checks';
    const failed = checks.filter((check) => check.status === 'failure' || check.status === 'error');
    const pending = checks.filter((check) => check.status === 'pending');
    if (failed.length)
        return failed.length + '/' + checks.length + ' FAILED (' + failed.map((c) => c.context).join(', ') + ')';
    if (pending.length)
        return pending.length + '/' + checks.length + ' pending';
    return checks.length + '/' + checks.length + ' green';
}
function print(state) {
    console.log(state.repo);
    if (state.main)
        console.log('  main   ' + state.main.sha.slice(0, 10) + '  ' + state.main.label);
    else
        console.log('  main   (unreadable)');
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
    for (const duplicate of state.duplicates)
        console.log('  DUPLICATE  ' + duplicate);
    for (const warning of state.warnings)
        console.log('  WARNING    ' + warning);
}
async function main() {
    const state = await collect();
    if (process.argv.includes('--json'))
        console.log(JSON.stringify(state, null, 2));
    else
        print(state);
    if (state.warnings.length)
        process.exitCode = 1;
}
main().catch((error) => {
    console.error('repo-state failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
});
