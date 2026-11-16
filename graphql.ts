// GraphQL v4: a small but real parser and executor over the forge's store, covering the
// schema surface the API exposes (viewer, repositories, issues, pull requests, mutations,
// connections with cursors, node ids and introspection of the checked types).

import { computeMerge, createIssue, createPull, mergePull, pullFiles } from './forge.ts';
import { sendJson, type Ctx } from './http.ts';
import { VIEWER, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const type = token.value;
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.parseVariableDefinitions();
        }
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'var', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        break;
    }
    throw new Error('unexpected value token');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      let args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        args = this.parseArguments();
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | undefined;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', field: { name, alias, args, selectionSet } });
    }
    return selections;
  }
}

// ---------------------------------------------------------------- values

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of field.args) out[name] = resolveValue(node, variables);
  return out;
}

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- runtime objects

interface Obj {
  __t: string;
  [key: string]: unknown;
}

const obj = (type: string, fields: Record<string, unknown>): Obj => ({ __t: type, ...fields });

interface ExecCtx {
  store: Store;
  variables: Variables;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
}

function repoByDbId(store: Store, dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`idx:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^idx:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface Connection {
  items: Obj[];
}

function connection(items: Obj[], args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : -1;
  const start = after + 1;
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : typeof args.after === 'string' ? args.after : null;
  return obj('Connection', { page, hasNext, endCursor });
}

// ---------------------------------------------------------------- schema tables (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'createdAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'isPrivate', 'description',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author',
    'repository', 'labels', 'comments',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'mergedAt',
  ],
  Ref: ['name', 'target', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Obj, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: RepoRec, pull: PullRec): Obj {
  return obj('PullRequest', { repo, pull });
}

function repoObj(repo: RepoRec): Obj {
  return obj('Repository', { repo });
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => obj('User', {}),
    repository: (_s, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : repoObj(repo);
    },
    node: (_s, args, ctx) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const repo = repoByDbId(ctx.store, Number(decoded.parts[0]));
        return repo === null ? null : repoObj(repo);
      }
      if (decoded.kind === 'I' || decoded.kind === 'P') {
        const repo = repoByDbId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) return null;
        const number = Number(decoded.parts[1]);
        if (decoded.kind === 'I') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueObj(repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullObj(repo, pull);
      }
      if (decoded.kind === 'U') return obj('User', {});
      return null;
    },
    __type: (_s, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && TYPE_ENUMS[name] === undefined) return null;
      return obj('__Type', { name });
    },
    __schema: () => obj('__Schema', {}),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.kind === 'R' ? repoByDbId(ctx.store, Number(decoded.parts[0])) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreateIssuePayload', { issue: null });
      }
      const result = createIssue(ctx.store, repo, { title: input.title, body: input.body });
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return obj('CreateIssuePayload', { issue: null });
      }
      return obj('CreateIssuePayload', { issue: issueObj(repo, result.issue) });
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      const repo = decoded !== null && decoded.kind === 'I' ? repoByDbId(ctx.store, Number(decoded.parts[0])) : null;
      const issue = repo !== null && decoded !== null ? repo.issues.get(Number(decoded.parts[1])) : undefined;
      if (repo === null || issue === undefined) {
        ctx.errors.push({ message: 'issue not found' });
        return obj('CloseIssuePayload', { issue: null });
      }
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObj(repo, issue) });
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.kind === 'R' ? repoByDbId(ctx.store, Number(decoded.parts[0])) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreatePullRequestPayload', { pullRequest: null });
      }
      const strip = (value: unknown): string => (typeof value === 'string' ? value.replace(/^refs\/heads\//, '') : '');
      const result = createPull(ctx.store, repo, {
        title: input.title,
        body: input.body,
        head: strip(input.headRefName),
        base: strip(input.baseRefName),
      });
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return obj('CreatePullRequestPayload', { pullRequest: null });
      }
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, result.pull) });
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      const repo = decoded !== null && decoded.kind === 'P' ? repoByDbId(ctx.store, Number(decoded.parts[0])) : null;
      const pull = repo !== null && decoded !== null ? repo.pulls.get(Number(decoded.parts[1])) : undefined;
      if (repo === null || pull === undefined) {
        ctx.errors.push({ message: 'pull request not found' });
        return obj('MergePullRequestPayload', { pullRequest: null });
      }
      const result = mergePull(repo, pull);
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull) });
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      const repo = decoded !== null && decoded.kind === 'I' ? repoByDbId(ctx.store, Number(decoded.parts[0])) : null;
      const issue = repo !== null && decoded !== null ? repo.issues.get(Number(decoded.parts[1])) : undefined;
      if (repo === null || issue === undefined) {
        ctx.errors.push({ message: 'subject not found' });
        return obj('AddCommentPayload', { commentEdge: null });
      }
      const comment = { id: repo.nextCommentId, body: typeof input.body === 'string' ? input.body : '' };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      const node = obj('Comment', { repo, comment });
      return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node }) });
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => globalId('U', VIEWER.id),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (s) => globalId('R', (s.repo as RepoRec).id),
    databaseId: (s) => (s.repo as RepoRec).id,
    name: (s) => (s.repo as RepoRec).name,
    nameWithOwner: (s) => `${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}`,
    owner: () => obj('User', {}),
    isPrivate: (s) => (s.repo as RepoRec).private,
    description: (s) => (s.repo as RepoRec).description,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (s) => {
      const repo = s.repo as RepoRec;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return obj('Ref', { name: repo.defaultBranch, oid: tip });
    },
    issue: (s, args) => {
      const repo = s.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (s, args) => {
      const repo = s.repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states !== undefined && states.length > 0) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connection(issues.map((issue) => issueObj(repo, issue)), args);
    },
    pullRequest: (s, args) => {
      const repo = s.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
    pullRequests: (s, args) => {
      const repo = s.repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states !== undefined && states.length > 0) {
        pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => a.number - b.number);
      return connection(pulls.map((pull) => pullObj(repo, pull)), args);
    },
  },
  Issue: {
    id: (s) => globalId('I', (s.repo as RepoRec).id, (s.issue as IssueRec).number),
    databaseId: (s) => (s.issue as IssueRec).id,
    number: (s) => (s.issue as IssueRec).number,
    title: (s) => (s.issue as IssueRec).title,
    body: (s) => (s.issue as IssueRec).body,
    state: (s) => (s.issue as IssueRec).state.toUpperCase(),
    author: () => obj('User', {}),
    repository: (s) => repoObj(s.repo as RepoRec),
  },
  PullRequest: {
    id: (s) => globalId('P', (s.repo as RepoRec).id, (s.pull as PullRec).number),
    databaseId: (s) => (s.pull as PullRec).id,
    number: (s) => (s.pull as PullRec).number,
    title: (s) => (s.pull as PullRec).title,
    body: (s) => (s.pull as PullRec).body,
    state: (s) => {
      const pull = s.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.pull as PullRec).merged,
    mergedAt: (s) => (s.pull as PullRec).mergedAt,
    headRefName: (s) => (s.pull as PullRec).headRef,
    baseRefName: (s) => (s.pull as PullRec).baseRef,
    mergeable: (s) => {
      const repo = s.repo as RepoRec;
      const pull = s.pull as PullRec;
      if (pull.merged) return 'UNKNOWN';
      const computation = computeMerge(repo, pull);
      if (computation === null) return 'UNKNOWN';
      return computation.conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (s, args) => {
      const repo = s.repo as RepoRec;
      const pull = s.pull as PullRec;
      const files = pullFiles(repo, pull).map((file) =>
        obj('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions }),
      );
      return connection(files, args);
    },
    author: () => obj('User', {}),
    repository: (s) => repoObj(s.repo as RepoRec),
  },
  Ref: {
    name: (s) => s.name as string,
  },
  Comment: {
    id: (s) => globalId('C', (s.repo as RepoRec).id, (s.comment as { id: number }).id),
    body: (s) => (s.comment as { body: string }).body,
    author: () => obj('User', {}),
  },
  Connection: {
    nodes: (s) => s.page as Obj[],
    pageInfo: (s) =>
      obj('PageInfo', {
        hasNextPage: s.hasNext as boolean,
        endCursor: s.endCursor as string | null,
      }),
    totalCount: (s) => (s.page as Obj[]).length,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage as boolean,
    hasPreviousPage: () => false,
    endCursor: (s) => s.endCursor as string | null,
    startCursor: (s) => s.endCursor as string | null,
  },
  CreateIssuePayload: { issue: (s) => s.issue as Obj | null },
  CloseIssuePayload: { issue: (s) => s.issue as Obj | null },
  CreatePullRequestPayload: { pullRequest: (s) => s.pullRequest as Obj | null },
  MergePullRequestPayload: { pullRequest: (s) => s.pullRequest as Obj | null },
  AddCommentPayload: { commentEdge: (s) => s.commentEdge as Obj | null },
  CommentEdge: { node: (s) => s.node as Obj, cursor: () => encodeCursor(0) },
  PullRequestChangedFile: {
    path: (s) => s.path as string,
    additions: (s) => s.additions as number,
    deletions: (s) => s.deletions as number,
  },
  __Type: {
    name: (s) => s.name as string,
    kind: (s) => (TYPE_ENUMS[s.name as string] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (s) => {
      const fields = TYPE_FIELDS[s.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => obj('__Field', { name }));
    },
    enumValues: (s) => {
      const values = TYPE_ENUMS[s.name as string];
      if (values === undefined) return null;
      return values.map((name) => obj('__EnumValue', { name }));
    },
  },
  __Field: { name: (s) => s.name as string },
  __EnumValue: { name: (s) => s.name as string },
  __Schema: {
    queryType: () => obj('__Type', { name: 'Query' }),
    mutationType: () => obj('__Type', { name: 'Mutation' }),
  },
};

// ---------------------------------------------------------------- executor

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && typeof (value as Obj).__t === 'string';
}

function executeSelectionSet(source: Obj, typeName: string, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(source, typeName, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(source, typeName, fragment.selectionSet, ctx));
      }
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    const value = resolver(source, argsOf(field, ctx.variables), ctx);
    out[responseKey] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (isObj(value)) return executeSelectionSet(value, value.__t, field.selectionSet, ctx);
  return value;
}

export function executeGraphQL(store: Store, query: string, variables: Variables, operationName?: string): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    document.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(obj(rootType, {}), rootType, operation.selectionSet, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- HTTP

export function handleGraphQL(ctx: Ctx): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Variables;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeGraphQL(ctx.store, query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(ctx, 200, parsed.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(parsed));
}
