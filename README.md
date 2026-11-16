# makefun-forge — a GitHub-compatible git forge for github-core-clone-01

A single-process, in-memory GitHub-compatible forge written in TypeScript on the Node
standard library alone. It implements the contest surface end to end over one shared store:

- **Git smart HTTP** (`gitproto.ts`): protocol v0 and v2 advertisement, `ls-refs`, fetch
  (including shallow clones and deepen), and receive-pack pushes with report-status —
  all over a real git object model (`gitobj.ts`: SHA-1 objects, packs with delta
  resolution, pkt-lines, ancestry and merge bases).
- **REST v3** (`rest.ts`): user, repositories, git refs, branches, commits, the contents
  API, labels, issues and comments, and pull requests with squash merges.
- **GraphQL v4** (`graphql.ts`): a small real parser/executor — viewer, repositories,
  issues and pull requests, connections with cursors, mutations (create/close issue,
  create/merge pull request, add comment), global node ids and introspection.
- **MCP** (`mcp.ts`): modern-era Streamable HTTP JSON-RPC (`server/discover`, `tools/list`,
  `tools/call`) with create/get repo, create/list issues, and create/merge pull request
  tools acting on the same store as the other surfaces.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (bind an ephemeral port, register with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0). The trial runs `node /bot/main.ts` on
Node 22.18+; there is nothing to install — the program imports only `node:*` built-ins
and its own modules.

## Layout

- `main.ts` — entry ↔ env lifecycle (unchanged from the kit starter).
- `app.ts` — HTTP server: health probe, bearer-token auth, surface dispatch.
- `store.ts` — the in-memory store (one authenticated user, repositories, objects, refs).
- `forge.ts` — domain logic shared by all surfaces (serializers, contents commits,
  the three-way squash-merge engine, pull-request file diffs).
- `gitobj.ts` / `gitproto.ts` — the git object model and the smart-HTTP protocol.
- `rest.ts` / `graphql.ts` / `mcp.ts` — the three API surfaces.
