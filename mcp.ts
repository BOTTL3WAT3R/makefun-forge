// The MCP endpoint: modern-era Streamable HTTP JSON-RPC (server/discover, tools/list,
// tools/call) acting on the same store as the REST and GraphQL surfaces.

import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './forge.ts';
import { sendEmpty, sendJson, type Ctx } from './http.ts';
import { VIEWER, type RepoRec } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

interface RpcOutcome {
  status: number;
  body?: Record<string, unknown>;
  empty?: boolean;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    result.structuredContent = value;
  }
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string {
  return typeof args[name] === 'string' ? (args[name] as string) : '';
}

function repoArg(ctx: Ctx, args: Record<string, unknown>): RepoRec | null {
  return ctx.store.getRepo(strArg(args, 'owner') || VIEWER.login, strArg(args, 'repo'));
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (ctx.store.getRepo(VIEWER.login, repoName) !== null) {
        return toolError(`repository ${repoName} already exists`);
      }
      const repo = ctx.store.createRepo({
        name: repoName,
        private: args.private === true,
        description: strArg(args, 'description'),
        defaultBranch: 'main',
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoArg(ctx, args);
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(ctx, args);
      if (repo === null) return toolError('repository not found');
      const result = createIssue(ctx.store, repo, { title: args.title, body: args.body, labels: args.labels });
      if (!result.ok) return toolError(result.message);
      return toolResult(issueJson(repo, result.issue));
    }
    case 'list_issues': {
      const repo = repoArg(ctx, args);
      if (repo === null) return toolError('repository not found');
      const state = strArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(ctx, args);
      if (repo === null) return toolError('repository not found');
      const result = createPull(ctx.store, repo, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (!result.ok) return toolError(result.message);
      return toolResult(pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(ctx, args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.number ?? args.pullNumber);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('pull request not found');
      const result = mergePull(repo, pull);
      if (!result.ok) return toolError(result.message);
      return toolResult(pullJson(repo, pull));
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function handleRpc(ctx: Ctx, message: Record<string, unknown>): RpcOutcome {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument ${required}`);
        }
      }
      return rpcResult(id, callTool(ctx, name, args));
    }
    default:
      if (isNotification) return { status: 202, empty: true };
      return rpcError(id, -32601, `method not found ${method}`);
  }
}

/** Handle POST /mcp. Auth has already been enforced by the app router. */
export function handleMcp(ctx: Ctx): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed.map((entry) =>
      handleRpc(ctx, (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>),
    );
    sendJson(ctx, 200, outcomes.map((outcome) => outcome.body));
    return;
  }
  const message = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const outcome = handleRpc(ctx, message);
  if (outcome.empty === true) {
    sendEmpty(ctx, outcome.status);
    return;
  }
  sendJson(ctx, outcome.status, outcome.body ?? {});
}
