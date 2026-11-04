# ITAM Platform: Phase 1 foundation

An enterprise IT asset, data-centre and IP management platform in the spirit of Device42. Phase 1 covers four things:
- the core PostgreSQL schema, with integrity enforced in the database
- a NestJS API for assets, rack placement and IPAM
- a Next.js interactive 42U rack elevation
- the architecture for the later modules: discovery, dependency mapping and integrations

See **[docs/architecture.md](docs/architecture.md)** for the system diagram and phase plan.

```
apps/api        NestJS 10 · Prisma 6 · hand-written SQL migrations (prisma/migrations)
apps/web        Next.js 14 App Router · Tailwind · RackElevation component
packages/shared Zod schemas + TypeScript types shared by API and web
```

## Quick start

```bash
cp .env.example .env                 # set JWT_SECRET (32+ chars)
docker compose up -d                 # postgres:16 + redis:7
pnpm install
pnpm --filter @itam/shared build
pnpm --filter @itam/api db:migrate   # applies prisma/migrations/0001_init/migration.sql
pnpm --filter @itam/api seed         # site, 42U rack with 10 devices, users per role, IP plan
pnpm --filter @itam/api dev          # http://localhost:4000/api/v1 · OpenAPI at /docs

# web: the server holds the API token; the browser never sees it
export API_TOKEN=$(pnpm --silent --filter @itam/api token --role dc_technician)
pnpm --filter @itam/web dev          # http://localhost:3000/racks  (or /racks/demo with no API)
```

## Tests

```bash
# API tests create a throwaway database on any Postgres 16 server you can CREATE DATABASE on
TEST_DATABASE_ADMIN_URL=postgresql://itam:itam@localhost:5432/postgres pnpm test
pnpm typecheck
```

- **`apps/api`, 43 tests:**
  - Unit tests: rack geometry and CIDR maths.
  - Database integrity: U-space EXCLUDE, rack height, subnet nesting and duplicates, IP-in-subnet, append-only audit, the CMDB blast-radius CTE.
  - API end to end: RBAC, a 409 with the conflicting device and suggested free slots, an 8-way placement race with exactly one winner, PATCH moves with before/after audit diffs, 50 concurrent IP allocations returning 50 distinct addresses, `SUBNET_FULL`, IPv6.
- **`apps/web`, 8 tests:** rack layout maths (grid rows, ghosts, free gaps, utilisation, kW/BTU, drop placement).

## Key design decisions

- **The database is the last line of defence.** Rack collisions are blocked by a GiST `EXCLUDE` constraint on `asset_rack_occupancy` (maintained by trigger: full-depth devices fill both faces, half-depth one, zero-U none). The API pre-checks first, so it can return a helpful 409 with the conflicting device and free slots.
- **IPAM uses native `cidr`/`inet`.** CIDRs are validated strictly: host bits are rejected with a suggestion, and legacy forms like `10.1` are refused. Parents are resolved automatically. Allocation locks the subnet row (`FOR UPDATE`), so concurrent requests never get the same IP, and it skips ranges carved out by child subnets.
- **The audit trail is append-only.** Each change writes its audit row in the same transaction as the change itself; UPDATE, DELETE and TRUNCATE on `audit_logs` raise.
- **RBAC:**

  | Role | Can do |
  |---|---|
  | `admin` | everything |
  | `dc_technician` | write assets and rack placements |
  | `network_engineer` | write IPAM |
  | `auditor` | read only |

  The role is read from the database on every request.
- **One error shape:** `{ statusCode, code, message, details }`, with stable codes such as `RACK_U_CONFLICT`, `RACK_U_OUT_OF_RANGE`, `CIDR_HOST_BITS_SET`, `SUBNET_EXISTS`, `SUBNET_FULL`, `IP_IN_USE` and `IP_OUTSIDE_SUBNET`.

## Schema workflow

`apps/api/prisma/migrations/*/migration.sql` is the source of truth. After changing the database, run `pnpm --filter @itam/api db:pull` to re-introspect `schema.prisma`. Columns Prisma can't model (`cidr`, `int4range`, `macaddr`) appear as `Unsupported`, and the services use parameterised raw SQL for them.
