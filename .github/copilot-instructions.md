# Polymarket Copy-Trading — `services/api` GitHub Copilot Instructions

## Repository Overview

`services/api` is the **core data, persistence, and administrative orchestration backend** for the Polymarket Copy-Trading ecosystem (`Lotso-trading`):
- Built on **NestJS 12**, Deno 2 runtime, and **MongoDB** (Mongoose).
- Exposes RESTful endpoints for the Vue 3 dashboard and background scripts.
- Hosts a high-performance **WebSocket Gateway** broadcasting real-time trade events (detected, validated, executed, rejected).
- Connects to `@polymarket-copy/shared` for all data contracts, schemas, and Discord embed formatting.

---

## 🏛️ Architecture & Clean Code Rules

1. **Modular NestJS Architecture**:
   - Distinct feature modules: `targets`, `trades`, `positions`, `config`, `metrics`, `websocket`.
   - Clear separation between Controllers (HTTP/WS routing), Services (business logic & aggregation), and Mongoose Schemas.
2. **Optimized MongoDB & Aggregations**:
   - Compound indexes must be maintained on critical query filters: `targetAddress`, `timestamp`, `status`.
   - Heavy financial metrics (cumulative PnL, win rate, total traded volume) must use native MongoDB aggregation pipelines rather than JS array mapping.
3. **Strict Typing & Zero `any`**:
   - Mode strict TypeScript (`noImplicitAny: true`). Zero `any` tolerated.
   - All input DTOs must be validated at runtime via Zod or class-validator with strict constraints.
4. **Single Biome Standard**:
   - All linting and formatting is enforced via Biome (`biome check .`).

---

## Commit Message Guidelines (Conventional Commits v1.0.0)

- Always follow `<type>(<scope>): <subject>` in imperative present mood (e.g. `feat(targets): add toggle endpoint for target whale tracking`).
- Primary scopes: `targets`, `trades`, `positions`, `config`, `metrics`, `websocket`, `db`, `schemas`, `auth`, `discord`, `deps`, `docker`, `ci`.
- Detailed commit instructions: See `.github/copilot-commit-instructions.md`.
