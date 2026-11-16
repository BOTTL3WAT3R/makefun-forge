// The forge's HTTP server: health probe, bearer-token auth, and dispatch to the git smart-HTTP,
// REST v3, GraphQL v4 and MCP surfaces, all over one in-memory store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { fail, makeCtx } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (EXPECTED_TOKEN !== '') return header === `Bearer ${EXPECTED_TOKEN}`;
  // No token configured in the environment: still demand a bearer header (never used in a trial).
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: 'Request body too large' }));
        return;
      }
      const ctx = makeCtx(store, req, res, body);
      try {
        // The env's boot probe: open, no token.
        if (ctx.method === 'GET' && ctx.url.pathname === '/healthz') {
          ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
          ctx.res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (!authorized(req)) {
          fail(ctx, 401, 'Bad credentials');
          return;
        }
        const segments = ctx.segments;
        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest(ctx, segments.slice(2));
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (ctx.method !== 'POST') {
            fail(ctx, 404, 'Not Found');
            return;
          }
          handleGraphQL(ctx);
          return;
        }
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (ctx.method !== 'POST') {
            fail(ctx, 405, 'Method Not Allowed');
            return;
          }
          handleMcp(ctx);
          return;
        }
        if (handleGit(ctx, segments)) return;
        fail(ctx, 404, 'Not Found');
      } catch {
        if (!res.headersSent) {
          try {
            fail(ctx, 500, 'Internal Server Error');
          } catch {
            // The peer is gone; nothing more to do.
          }
        } else {
          try {
            res.end();
          } catch {
            // Already closed.
          }
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
