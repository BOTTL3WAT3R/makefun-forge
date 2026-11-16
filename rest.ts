// The REST v3 surface: root, meta, user, repos, refs, branches, commits, contents, labels,
// issues, comments and pulls — all answering GitHub-shaped JSON.

import {
  commentJson,
  commitJson,
  createIssue,
  createPull,
  issueJson,
  labelJson,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  readContent,
  repoJson,
  userJson,
} from './forge.ts';
import { bodyIsMalformedJson, fail, jsonBody, paginate, sendEmpty, sendJson, type Ctx } from './http.ts';
import { resolveRef, VIEWER, type RepoRec } from './store.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Handle one /api/v3 request. Segments are the path after /api/v3. */
export function handleRest(ctx: Ctx, segments: string[]): void {
  const { method } = ctx;

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        ctx,
        200,
        {
          current_user_url: `${ctx.origin}/api/v3/user`,
          rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
          repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '3.16.0.makefun-forge', verifiable_password_authentication: false });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userJson());
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = paginate(ctx, ctx.store.listRepos(), '/api/v3/user/repos');
      sendJson(ctx, 200, page.items.map(repoJson), page.link !== null ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      if (bodyIsMalformedJson(ctx)) {
        fail(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const body = asRecord(jsonBody(ctx));
      const name = str(body.name);
      if (name === '') {
        fail(ctx, 422, 'Validation Failed: name is required');
        return;
      }
      if (ctx.store.getRepo(VIEWER.login, name) !== null) {
        fail(ctx, 422, 'Validation Failed: name already exists on this account');
        return;
      }
      const repo = ctx.store.createRepo({
        name,
        private: body.private === true,
        description: str(body.description),
        defaultBranch: str(body.default_branch) || 'main',
      });
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = ctx.store.getRepo(owner, name);
    if (repo === null) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    handleRepo(ctx, repo, segments.slice(3));
    return;
  }

  fail(ctx, 404, 'Not Found');
}

function handleRepo(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const { method } = ctx;
  const repoPath = `/api/v3/repos/${repo.owner}/${repo.name}`;

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = asRecord(jsonBody(ctx));
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        ctx.store.repos.delete(ctx.store.key(repo.owner, repo.name));
        repo.name = body.name;
        ctx.store.repos.set(ctx.store.key(repo.owner, repo.name), repo);
      }
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo);
      sendEmpty(ctx, 204);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'POST') {
        const body = asRecord(jsonBody(ctx));
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || sha === '') {
          fail(ctx, 422, 'Validation Failed: ref and sha are required');
          return;
        }
        const object = repo.objects.get(sha);
        if (object === undefined) {
          fail(ctx, 422, 'Validation Failed: sha does not identify an object');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(ctx, 201, { ref, node_id: `REF:${ref}`, object: { sha, type: object.type } });
        return;
      }
      if (method === 'GET') {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
        }));
        sendJson(ctx, 200, all);
        return;
      }
    } else {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          fail(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, { ref, node_id: `REF:${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(ref)) {
          fail(ctx, 422, 'Validation Failed: reference does not exist');
          return;
        }
        sendEmpty(ctx, 204);
        return;
      }
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(ctx, 200, branches);
      return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = ctx.url.searchParams.get('sha');
      let tip: string | null;
      if (shaParam !== null && shaParam !== '') tip = resolveRef(repo, shaParam);
      else tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (tip === null) {
        sendJson(ctx, 200, []);
        return;
      }
      const page = paginate(ctx, commitsList(repo, tip), `${repoPath}/commits`);
      sendJson(ctx, 200, page.items, page.link !== null ? { link: page.link } : {});
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const json = commitJson(repo, rest[1] as string);
      if (json === null) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, json);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const refParam = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
      const commitOid = resolveRef(repo, refParam);
      if (commitOid === null) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const found = readContent(repo, commitOid, path);
      if (found === null) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (found.kind === 'file') {
        const blob = repo.objects.get(found.oid);
        const content = (blob?.data ?? Buffer.alloc(0)).toString('base64');
        sendJson(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          name: path.split('/').pop() ?? path,
          path,
          sha: found.oid,
          size: found.size,
          content,
        });
        return;
      }
      sendJson(
        ctx,
        200,
        found.entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        })),
      );
      return;
    }
    if (method === 'PUT') {
      const body = asRecord(jsonBody(ctx));
      const encoded = str(body.content);
      const content = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
      const result = putContent(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        content,
        message: str(body.message) || 'Update file',
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (result.commitSha === undefined) {
        fail(ctx, result.status, result.message ?? 'Error');
        return;
      }
      sendJson(ctx, result.status, {
        content: {
          type: 'file',
          encoding: 'base64',
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobSha,
          size: content.length,
        },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = asRecord(jsonBody(ctx));
      const result = putContent(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        content: null,
        message: str(body.message) || 'Delete file',
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (result.commitSha === undefined) {
        fail(ctx, result.status === 404 ? 404 : result.status, result.message ?? 'Error');
        return;
      }
      sendJson(ctx, 200, { content: null, commit: { sha: result.commitSha } });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const body = asRecord(jsonBody(ctx));
      const name = str(body.name);
      if (name === '') {
        fail(ctx, 422, 'Validation Failed: name is required');
        return;
      }
      if (repo.labels.has(name)) {
        fail(ctx, 422, 'Validation Failed: label already exists');
        return;
      }
      const color = str(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(ctx, 201, labelJson(repo, name));
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- issues and comments
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = asRecord(jsonBody(ctx));
        const result = createIssue(ctx.store, repo, body);
        if (!result.ok) {
          fail(ctx, result.status, result.message);
          return;
        }
        sendJson(ctx, 201, issueJson(repo, result.issue));
        return;
      }
      if (method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const direction = ctx.url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const page = paginate(ctx, issues, `${repoPath}/issues`);
        sendJson(ctx, 200, page.items.map((issue) => issueJson(repo, issue)), page.link !== null ? { link: page.link } : {});
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(ctx, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const body = asRecord(jsonBody(ctx));
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names: string[] = [];
          for (const raw of body.labels) {
            const name = typeof raw === 'string' ? raw : '';
            if (name !== '') {
              if (!repo.labels.has(name)) {
                fail(ctx, 422, `Validation Failed: label "${name}" does not exist`);
                return;
              }
              names.push(name);
            }
          }
          issue.labels = names;
        }
        sendJson(ctx, 200, issueJson(repo, issue));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (method === 'POST') {
        const body = asRecord(jsonBody(ctx));
        const comment = { id: repo.nextCommentId, body: str(body.body) };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(ctx, 201, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        sendJson(ctx, 200, issue.comments.map(commentJson));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = asRecord(jsonBody(ctx));
        const result = createPull(ctx.store, repo, body);
        if (!result.ok) {
          fail(ctx, result.status, result.message);
          return;
        }
        sendJson(ctx, 201, pullJson(repo, result.pull));
        return;
      }
      if (method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.number - a.number);
        const page = paginate(ctx, pulls, `${repoPath}/pulls`);
        sendJson(ctx, 200, page.items.map((pull) => pullJson(repo, pull)), page.link !== null ? { link: page.link } : {});
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, pullJson(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, pullFiles(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const body = asRecord(jsonBody(ctx));
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
        fail(ctx, 405, 'Method Not Allowed: unknown merge method');
        return;
      }
      const result = mergePull(repo, pull);
      if (!result.ok) {
        fail(ctx, result.status, result.message);
        return;
      }
      sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  fail(ctx, 404, 'Not Found');
}

function commitsList(repo: RepoRec, tip: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const json = commitJson(repo, oid);
    if (json === null) return;
    out.push(json);
    const parents = (json.parents as { sha: string }[]).map((parent) => parent.sha);
    for (const parent of parents) visit(parent);
  };
  visit(tip);
  return out;
}
