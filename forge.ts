// Domain logic shared by the REST, GraphQL and MCP surfaces: serializers, the contents-commit
// engine, issue/pull creation and the squash-merge engine.

import {
  buildCommitData,
  commitOf,
  flattenTree,
  isAncestor,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  storeObject,
  unflattenTree,
  ZERO_OID,
} from './gitobj.ts';
import { VIEWER, headRef, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- serializers

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R:${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I:${repo.id}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: `P:${repo.id}:${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha ?? ZERO_OID, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha ?? ZERO_OID, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function commitJson(repo: RepoRec, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const iso = (ts: number): string => new Date(ts * 1000).toISOString();
  return {
    sha: oid,
    node_id: `C:${oid}`,
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: iso(commit.authorTs) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: iso(commit.committerTs) },
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- issues

export type CreateIssueResult = { ok: true; issue: IssueRec } | { ok: false; status: number; message: string };

export function createIssue(
  store: Store,
  repo: RepoRec,
  input: { title?: unknown; body?: unknown; labels?: unknown },
): CreateIssueResult {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return { ok: false, status: 422, message: 'Validation Failed: title is required' };
  const body = typeof input.body === 'string' ? input.body : '';
  const labels: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const raw of input.labels) {
      const name = typeof raw === 'string' ? raw : typeof (raw as { name?: unknown })?.name === 'string' ? ((raw as { name: string }).name) : '';
      if (name === '') continue;
      if (!repo.labels.has(name)) {
        return { ok: false, status: 422, message: `Validation Failed: label "${name}" does not exist` };
      }
      labels.push(name);
    }
  }
  const issue: IssueRec = {
    id: store.nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdSeq: repo.nextNumber,
  };
  store.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { ok: true, issue };
}

// ---------------------------------------------------------------- contents commits

export interface PutContentResult {
  status: number;
  commitSha?: string;
  blobSha?: string;
  created?: boolean;
  message?: string;
}

/** Create or update (content != null) or delete (content == null) a file on a branch, as a commit. */
export function putContent(
  repo: RepoRec,
  input: { branch?: string; path: string; content: Buffer | null; message: string; sha?: string },
): PutContentResult {
  const branchName = input.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branchName}`;
  let tip = repo.refs.get(refName) ?? null;
  if (tip === null && branchName !== repo.defaultBranch) {
    // A contents write to a new branch forks it from the default branch tip.
    tip = repo.refs.get(headRef(repo)) ?? null;
  }
  const tipCommit = tip !== null ? commitOf(repo.objects, tip) : null;
  const files = tipCommit !== null ? flattenTree(repo.objects, tipCommit.tree) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(input.path);
  if (input.sha !== undefined) {
    if (existing === undefined || existing.oid !== input.sha) {
      return { status: 409, message: 'Conflict: the sha does not match the current file' };
    }
  } else if (existing !== undefined && input.content !== null) {
    return { status: 422, message: 'Validation Failed: "sha" is required when updating a file' };
  }
  if (input.content === null && existing === undefined) {
    return { status: 404, message: 'Not Found: no such file' };
  }
  const next = new Map(files);
  let blobSha: string | undefined;
  if (input.content !== null) {
    blobSha = storeObject(repo.objects, 'blob', input.content);
    next.set(input.path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  } else {
    next.delete(input.path);
  }
  const tree = unflattenTree(repo.objects, next);
  const commitData = buildCommitData({
    tree,
    parents: tip !== null ? [tip] : [],
    message: input.message,
    author: { name: VIEWER.name, email: VIEWER.email },
    committer: { name: VIEWER.name, email: VIEWER.email },
    ts: nowSec(),
  });
  const commitSha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  return { status: existing === undefined ? 201 : 200, commitSha, blobSha, created: existing === undefined };
}

export type ContentRead =
  | { kind: 'file'; oid: string; size: number }
  | { kind: 'dir'; entries: { name: string; path: string; oid: string; type: 'file' | 'dir' }[] };

/** Read a file or directory at a commit; null when the path does not exist there. */
export function readContent(repo: RepoRec, commitOid: string, path: string): ContentRead | null {
  const commit = commitOf(repo.objects, commitOid);
  if (commit === null) return null;
  let treeOid = commit.tree;
  if (path !== '') {
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          treeOid = entry.oid;
          break;
        }
        const blob = repo.objects.get(entry.oid);
        return { kind: 'file', oid: entry.oid, size: blob?.data.length ?? 0 };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
  }
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const entries = parseTree(tree.data).map((entry) => ({
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    oid: entry.oid,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
  return { kind: 'dir', entries };
}

// ---------------------------------------------------------------- pulls and merging

export type CreatePullResult = { ok: true; pull: PullRec } | { ok: false; status: number; message: string };

export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): CreatePullResult {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const head = typeof input.head === 'string' ? input.head.replace(/^[^:]+:/, '') : '';
  const base = typeof input.base === 'string' ? input.base.replace(/^[^:]+:/, '') : '';
  if (head === '' || repo.refs.get(`refs/heads/${head}`) === undefined) {
    return { ok: false, status: 422, message: `Validation Failed: head branch "${head}" does not exist` };
  }
  if (base === '' || repo.refs.get(`refs/heads/${base}`) === undefined) {
    return { ok: false, status: 422, message: `Validation Failed: base branch "${base}" does not exist` };
  }
  const pull: PullRec = {
    id: store.nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    createdSeq: repo.nextNumber,
  };
  store.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { ok: true, pull };
}

export interface MergeComputation {
  conflict: boolean;
  mergedFiles: Map<string, { oid: string; mode: string }>;
  baseTip: string;
  headTip: string;
}

/** Three-way file-level merge of a pull's head onto its base's current tip. */
export function computeMerge(repo: RepoRec, pull: PullRec): MergeComputation | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const baseCommit = commitOf(repo.objects, baseTip);
  const headCommit = commitOf(repo.objects, headTip);
  if (baseCommit === null || headCommit === null) return null;
  const base = mergeBase(repo.objects, headTip, baseTip) ?? baseTip;
  const baseCommitOfMerge = commitOf(repo.objects, base);
  if (baseCommitOfMerge === null) return null;
  const ancestorFiles = flattenTree(repo.objects, baseCommitOfMerge.tree);
  const baseFiles = flattenTree(repo.objects, baseCommit.tree);
  const headFiles = flattenTree(repo.objects, headCommit.tree);
  const merged = new Map(baseFiles);
  let conflict = false;
  const paths = new Set<string>([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    if (sameEntry(ancestor, head)) continue; // head did not change this path
    const current = baseFiles.get(path);
    if (sameEntry(current, ancestor)) {
      // Base did not touch it: take head's version (or its deletion).
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
    } else if (!sameEntry(current, head)) {
      conflict = true;
    }
  }
  return { conflict, mergedFiles: merged, baseTip, headTip };
}

function sameEntry(a: { oid: string } | undefined, b: { oid: string } | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; status: number; message: string };

/** Squash-merge a pull onto its base branch. */
export function mergePull(repo: RepoRec, pull: PullRec): MergeResult {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull Request has already been merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull Request is not open' };
  const computation = computeMerge(repo, pull);
  if (computation === null) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  if (computation.conflict) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable: merge conflict' };
  }
  const tree = unflattenTree(repo.objects, computation.mergedFiles);
  const message = `${pull.title} (#${pull.number})`;
  const commitData = buildCommitData({
    tree,
    parents: [computation.baseTip],
    message,
    author: { name: VIEWER.name, email: VIEWER.email },
    committer: { name: VIEWER.name, email: VIEWER.email },
    ts: nowSec(),
  });
  const sha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Whether a commit is reachable from a branch (used by tests of merge outcomes). */
export function commitOnBranch(repo: RepoRec, branch: string, oid: string): boolean {
  const tip = branchTip(repo, branch);
  if (tip === null) return false;
  return isAncestor(repo.objects, oid, tip);
}

export function commitsFrom(repo: RepoRec, tip: string): string[] {
  return listCommits(repo.objects, tip);
}

// ---------------------------------------------------------------- pull file diffs

export interface PullFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** LCS-based line diff counts; bounded so pathological files stay cheap. */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 1_000_000) {
    // Fall back to a prefix/suffix trim approximation for very large files.
    let prefix = 0;
    while (prefix < Math.min(n, m) && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < Math.min(n, m) - prefix && oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]) suffix += 1;
    return { additions: m - prefix - suffix, deletions: n - prefix - suffix };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * (m + 1) + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + j + 1] as number);
    }
  }
  const lcs = dp[0] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

export function pullFiles(repo: RepoRec, pull: PullRec): PullFileEntry[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headCommit = commitOf(repo.objects, headTip);
  if (headCommit === null) return [];
  const base = mergeBase(repo.objects, headTip, baseTip) ?? baseTip;
  const baseCommit = commitOf(repo.objects, base);
  if (baseCommit === null) return [];
  const baseFiles = flattenTree(repo.objects, baseCommit.tree);
  const headFiles = flattenTree(repo.objects, headCommit.tree);
  const out: PullFileEntry[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (sameEntry(before, after)) continue;
    const oldText = before !== undefined ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const newText = after !== undefined ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = diffCounts(oldText, newText);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}
