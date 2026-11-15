# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ronggosws21/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ronggosws21/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process with zero dependencies: git smart HTTP (protocol v0 and v2 — upload-pack, receive-pack, ls-refs, shallow fetch), the REST v3 API (repositories, contents, issues, labels, pull requests and merges), GraphQL v4 (viewer, repository, node(id:), connections with cursor pagination, mutations, introspection) and an MCP endpoint (server/discover, tools/list, tools/call) — all four surfaces over one in-memory store, so an object created on any surface reads identically on the others.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ng5ec2jy&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
