// Small HTTP plumbing shared by every surface: request context, JSON answers, pagination.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  segments: string[];
  body: Buffer;
  origin: string;
  requestId: string;
}

export function makeCtx(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): Ctx {
  const url = new URL(req.url ?? '/', 'http://entry');
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const host = req.headers.host ?? '127.0.0.1';
  return {
    store,
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    url,
    segments,
    body,
    origin: `http://${host}`,
    requestId: randomUUID(),
  };
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

export function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

export function sendRaw(ctx: Ctx, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(body);
}

export function fail(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Parse the request JSON body; undefined when empty or not an object/array. */
export function jsonBody(ctx: Ctx): Record<string, unknown> | unknown[] | undefined {
  if (ctx.body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown> | unknown[];
    return undefined;
  } catch {
    return undefined;
  }
}

export function bodyIsMalformedJson(ctx: Ctx): boolean {
  if (ctx.body.length === 0) return false;
  try {
    JSON.parse(ctx.body.toString('utf8'));
    return false;
  } catch {
    return true;
  }
}

export interface Page<T> {
  items: T[];
  link: string | null;
}

/** Slice a list by ?page=&per_page= and build a GitHub-style Link header when more pages exist. */
export function paginate<T>(ctx: Ctx, all: readonly T[], path: string): Page<T> {
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const make = (target: number): string => {
      const params = new URLSearchParams(ctx.url.searchParams);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `${ctx.origin}${path}?${params.toString()}`;
    };
    const parts = [`<${make(page + 1)}>; rel="next"`, `<${make(totalPages)}>; rel="last"`];
    if (page > 1) parts.push(`<${make(1)}>; rel="first"`, `<${make(page - 1)}>; rel="prev"`);
    link = parts.join(', ');
  }
  return { items, link };
}
