// The forge's in-memory store: one user, their repositories, git objects, issues and pulls.

import { peelToCommit, type GitObject } from './gitobj.ts';

export interface UserRec {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** The one authenticated user of this single-user forge (the trial token's identity). */
export const VIEWER: UserRec = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export class Store {
  repos = new Map<string, RepoRec>();
  nextRepoId = 5000;
  nextIssueId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(input: { name: string; private: boolean; description: string; defaultBranch: string }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name: input.name,
      private: input.private,
      description: input.description,
      defaultBranch: input.defaultBranch,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.seq,
    };
    this.nextRepoId += 1;
    this.seq += 1;
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

/** The ref a repo's HEAD names. */
export function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Resolve a branch name, full ref, or raw oid to a commit oid; null when it does not resolve. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    return object !== undefined && object.type === 'commit' ? ref : null;
  }
  const candidates = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') return oid;
      if (object !== undefined && object.type === 'tag') {
        return peelToCommit(repo.objects, oid);
      }
      return oid;
    }
  }
  return null;
}
