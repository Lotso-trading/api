# GitHub Copilot Commit Message Generation Instructions — `services/api`

You are an expert Git commit message generator for `services/api`, the NestJS and MongoDB backend of the Polymarket Copy-Trading ecosystem.

Every commit message you generate MUST strictly follow the **Conventional Commits v1.0.0** specification, because commits pushed to `main` trigger automated container builds and production Docker Swarm deployments via `semantic-release`.

---

## 1. Golden Rules: SemVer Releases & Accurate Classification

- `feat` -> Minor bump (`v0.X.0` or `vX.Y.0`) + Docker build + Swarm deployment
- `fix` or `perf` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `refactor` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `chore(deps)` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `BREAKING CHANGE:` or `!` -> Major bump (`vX.0.0`) + Docker build + Swarm deployment

### Classification Guidelines:

1. **Use `feat:`** for new API routes, database schemas, WebSocket events, Discord notification logic, or configuration fields.
2. **Use `fix:`** for bugfixes in services, route handlers, error filters, or data serialization issues.
3. **Use `perf:`** for MongoDB compound indexing, query optimization, or WebSocket payload throttling.
4. **Use `refactor:`** for restructuring NestJS modules, extracting reusable providers, or cleaning up service methods.
5. **Use `chore(deps):`** for dependency updates (NestJS, Mongoose, Deno).
6. **Use `chore:` (other scopes)** for seed scripts, local tooling, or `.gitignore`.
7. **Use `docs:`, `style:`, `test:`, `ci:`, `build:`** for docs, Biome formatting, unit tests, or CI workflows.

---

## 2. Mandatory Format

```text
<type>(<scope>): <subject in imperative present mood>

[optional body explaining "why" and "how"]

[optional footer: BREAKING CHANGE: <explanation> or Fixes #<issue>]
```

### Subject (Header) Rules:

1. **Type & Scope**: Strictly lowercase (e.g. `feat(positions):`, `fix(websocket):`, `perf(db):`).
2. **Language**: English ONLY.
3. **Imperative mood**: Use `add`, `fix`, `update`, `remove`, `refactor`, `prevent`, `implement`.
4. **Initial letter**: Lowercase (e.g., `fix(targets): handle duplicate address error` NOT `fix(targets): Handle...`), unless starting with an acronym like `USDC`, `EIP-712`, `CLOB`, `RPC`, `API`, `URL`, `ID`.
5. **Length**: 50 to 72 characters max.
6. **No trailing period**: NEVER end with a dot (`.`).
7. **No emojis**: Never include emojis in the subject.

---

## 3. Authorized Scopes for `services/api`

- `targets`: Whale addresses tracking, CRUD, active toggling, and target metrics.
- `trades`: Trade history logging, deduplication checks, and trade status updates.
- `positions`: Open/closed position monitoring, settlement resolution, and PnL calculation.
- `config`: Global risk and bot configuration endpoints and models.
- `metrics`: Financial analytics, win rate aggregation, and portfolio valuation.
- `websocket`: WebSocket Gateway, event dispatching, and client subscription management.
- `db`: Mongoose connection, indexing strategies, migrations, and aggregation pipelines.
- `schemas`: MongoDB document schemas and type mappings.
- `auth`: Authentication, headers, API keys, and route guards.
- `discord`: Discord webhook notifications, alerts, and embed generation.
- `deps`: Dependency updates.
- `docker`: Dockerfile and container configuration.
- `ci`: CI workflows and testing automation.

---

## 4. Examples

### Good Examples:

- `feat(config): add maxAllocatedCapitalUsdc to ConfigModel and service`
- `fix(positions): prevent duplicate settlement resolution on closed trades`
- `perf(db): optimize trade history query with compound index on timestamp`
- `feat(websocket): broadcast real-time target status updates to clients`
- `fix(discord): deduplicate alerts sent to Discord webhook on rapid fills`
- `refactor(trades): extract position calculation logic into dedicated service`
- `chore(deps): update @nestjs/common to v11.1.2`

### Bad Examples to Avoid:

- ❌ `Fix mongo query.` (vague, capitalized, trailing period)
- ❌ `feat: add endpoint` (missing scope, vague)
- ❌ `feat(api): 🚀 Implemented websocket` (contains emoji, past tense, capitalized)
