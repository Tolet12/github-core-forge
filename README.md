# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Tolet12/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Tolet12/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in pure TypeScript on the Node standard library alone —
no dependencies, no git binary, no shelling out. One in-memory store backs four surfaces
that all observe the same state: git smart-HTTP, the REST v3 API, GraphQL v4, and an
MCP streamable-HTTP endpoint for agents.

## Architecture

- `gitcore.ts` — the git object model from scratch: SHA-1 object ids, tree/commit/tag
  codecs, packfile reader (v2/v3, OFS_DELTA and REF_DELTA, thin-pack fixup against the
  local store) and writer, pkt-line framing and side-band-64k multiplexing.
- `store.ts` — the in-memory store: objects, repositories, refs, issues, comments,
  labels and pull requests; ancestry and merge-base walks over the commit graph,
  three-way tree merges for squash merges, and a per-repo pack cache keyed by fetch plan.
- `app.ts` — the HTTP surfaces:
  - **Git smart-HTTP** at `/<owner>/<repo>.git/…`: protocol v2 advertisements with
    `ls-refs` (ref-prefix filtering, symref and peeled targets) and `fetch`
    (acknowledgments, shallow/deepen with shallow-info, side-band progress), a v0
    fallback for both services, and receive-pack with per-ref fast-forward enforcement —
    a mixed push applies the fast-forward refs and reports `ng <ref> non-fast-forward`
    for the rest, over report-status on side-band-64k.
  - **REST v3** under `/api/v3`: repositories (CRUD, pagination with Link headers),
    branches, commits, contents (create/update/delete with sha checks), git refs,
    labels, issues and comments, and pull requests (list/get/files and squash merge —
    200 with the merge sha, 405 on conflict, merged state readable back). Every reply is
    JSON with an `X-GitHub-Request-Id`; auth is `Authorization: Bearer <token>` and the
    token's user is the viewer.
  - **GraphQL** at `/api/graphql`: a focused executor for the documents `gh` and
    github-mcp-server send — viewer, repository, node(id:) round-trips, introspection
    (`__type` fields and enum values), issue connections with cursor pagination and
    state/order filters, pull request files, and the createIssue / closeIssue /
    createPullRequest / mergePullRequest / addComment mutations, with opaque stable
    global ids and batched-operation support.
  - **MCP** at `/mcp`: both protocol eras — `server/discover` (2026-07-28) and legacy
    `initialize` — with six tools (`create_repo`, `get_repo`, `create_issue`,
    `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same
    store, JSON-RPC error discipline (-32700/-32601/-32602) and byte-identical
    `tools/list` responses.
- `main.ts` — the entry↔environment lifecycle (bind an ephemeral port, register it,
  poll until done), unchanged from the contest starter.

Deterministic by construction: timestamps derive from a logical sequence counter, not
the wall clock, and fetch packs are cached per plan so repeated clones are cheap.

## Local conformance results

Run against the kit's own suite (`sdk/run.ts`, byte-identical to the grading suite),
fresh server, `--perf`:

- **120 of 120 checks pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  graphql 20/20, mcp 15/15, protocol 5/5.
- feature 600 + agent 200 + perf 121 = **921 of 1000** locally (an earlier identical
  run measured perf 129 / 929; the difference is shared-CPU variance, both runs pass
  all 120 checks — the full output of the final run is in `SUITE-RESULTS.txt`).
- Benchmarks (p50 vs the production reference): push 729.2 ms vs 1640.8 (40 pts),
  clone 258.7 ms vs 266.9 (26 pts), read 2382.5 ms vs 2759.7 (28 pts),
  write 316.9 ms vs 349.0 (27 pts).

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> MAKEFUN_SHOP_TOKEN=<token> npm start
```

`main.ts` binds an ephemeral port and registers it with the env at `MAKEFUN_ENV_URL`;
the bearer token the suite presents is read from `MAKEFUN_SHOP_TOKEN`. To embed the
forge in your own server instead, `createApp()` in `app.ts` returns a ready
`http.Server` (Node ≥ 22.18, `--experimental-strip-types`, no install step).

---

<sub>Entered on [make.fun](https://make.fun/?ref=q1abmz0q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
