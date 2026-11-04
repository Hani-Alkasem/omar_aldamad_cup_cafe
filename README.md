# ITAM Platform

An enterprise IT asset, data-centre and IP management platform in the spirit of Device42.

- **Phase 1:**
  - the core PostgreSQL schema, with integrity enforced in the database
  - a NestJS API for assets, rack placement and IPAM
  - an interactive 42U rack elevation
- **Phase 2:**
  - asset lifecycle: vendors, POs, warranty/support contracts, depreciation, maintenance
  - component inventory
  - ports and cabling with patch-panel path trace
  - PDU outlets and a rack power budget
  - QR asset labels that open a mobile asset page

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
pnpm --filter @itam/api db:migrate   # applies prisma/migrations/*/migration.sql in order
pnpm --filter @itam/api seed         # rack with 11 devices, users per role, IP plan, contracts, cabling, A/B power
pnpm --filter @itam/api dev          # http://localhost:4000/api/v1 · OpenAPI at /docs

# web: the server holds the API token; the browser never sees it
export API_TOKEN=$(pnpm --silent --filter @itam/api token --role dc_technician)
pnpm --filter @itam/web dev          # http://localhost:3000/racks  (or /racks/demo with no API)

# QR labels: open a rack → Print labels, or /labels?ids=<uuid,uuid>. Labels encode
# $PUBLIC_BASE_URL/a/<asset tag>, which redirects to the mobile asset page.
```

## Tests

```bash
# API tests create a throwaway database on any Postgres 16 server you can CREATE DATABASE on
TEST_DATABASE_ADMIN_URL=postgresql://itam:itam@localhost:5432/postgres pnpm test
pnpm typecheck
```

- **`apps/api`, 65 tests:**
  - Unit tests: rack geometry, CIDR maths, depreciation, cable path trace, rack power budget.
  - Database integrity: U-space EXCLUDE, rack height, subnet nesting and duplicates, IP-in-subnet, append-only audit, the CMDB blast-radius CTE.
  - API end to end: RBAC, a 409 with the conflicting device and suggested free slots, an 8-way placement race with exactly one winner, PATCH moves with before/after audit diffs, 50 concurrent IP allocations returning 50 distinct addresses, `SUBNET_FULL`, IPv6.
  - Phase 2 end to end:
    - contract expiry, notice window and coverage gaps
    - book value
    - maintenance rescheduling
    - component summary
    - server → patch panel → switch trace, plus `PORT_IN_USE` and `PORT_CABLED`
    - A/B power load split, single-feed detection after pulling a cord, `powered_by` edges kept in sync on insert, re-plug and unplug
    - QR lookup
- **`apps/web`, 8 tests:** rack layout maths (grid rows, ghosts, free gaps, utilisation, kW/BTU, drop placement).

## Key design decisions

- **The database is the last line of defence.** Rack collisions are blocked by a GiST `EXCLUDE` constraint on `asset_rack_occupancy` (maintained by trigger: full-depth devices fill both faces, half-depth one, zero-U none). The API pre-checks first, so it can return a helpful 409 with the conflicting device and free slots.
- **IPAM uses native `cidr`/`inet`.** CIDRs are validated strictly: host bits are rejected with a suggestion, and legacy forms like `10.1` are refused. Parents are resolved automatically. Allocation locks the subnet row (`FOR UPDATE`), so concurrent requests never get the same IP, and it skips ranges carved out by child subnets.
- **The audit trail is append-only.** Each change writes its audit row in the same transaction as the change itself; UPDATE, DELETE and TRUNCATE on `audit_logs` raise.
- **RBAC:**

  | Role | Can do |
  |---|---|
  | `admin` | everything |
  | `dc_technician` | write assets, rack placements, components, ports, power, maintenance |
  | `network_engineer` | write IPAM and cables |
  | `auditor` | read only |

  The role is read from the database on every request.
- **One error shape:** `{ statusCode, code, message, details }`, with stable codes such as `RACK_U_CONFLICT`, `RACK_U_OUT_OF_RANGE`, `CIDR_HOST_BITS_SET`, `SUBNET_EXISTS`, `SUBNET_FULL`, `IP_IN_USE`, `IP_OUTSIDE_SUBNET`, `PORT_IN_USE`, `PORT_CABLED`, `POWER_PORT_IN_USE` and `POWER_CONNECTION_INVALID`.

## Phase 2 API

| Route | Notes |
|---|---|
| `GET/POST /vendors`, `POST /purchase-orders` | admin |
| `POST /contracts`, `GET /contracts/:id`, `POST/DELETE /contracts/:id/assets` | warranty, support, lease, maintenance, licence |
| `GET /contracts/expiring?withinDays=90&type=` | adds `inNoticeWindow` (end date minus notice days has passed) |
| `GET /contracts/coverage-gaps` | active hardware with no warranty or support in force today |
| `GET /assets/:id/contracts` | contracts covering one asset |
| `GET/PUT /assets/:id/financials` | returns depreciation summary and current book value |
| `GET/POST /assets/:id/maintenance`, `POST /maintenance/:id/complete`, `GET /maintenance/due` | next due date is generated in the DB |
| `GET/POST /assets/:id/components`, `DELETE /components/:id` | summary: CPU cores, memory GB, disk GB, GPUs |
| `GET/POST /assets/:id/ports`, `POST /assets/:id/ports/bulk`, `DELETE /ports/:id`, `GET /ports?mac=` | `patchPanel: true` creates paired front/rear ports |
| `POST /cables`, `DELETE /cables/:id`, `GET /ports/:id/trace` | end-to-end path through patch panels |
| `GET /assets/:id/power-ports`, `POST /assets/:id/power-ports/bulk` | outlets only on PDUs/UPSes |
| `POST /power-connections`, `DELETE /power-connections/:id` | maintains `powered_by` CMDB edges |
| `GET /racks/:id/power` | per-PDU load, headroom, BTU/h, `unpowered`, `singleFed` |
| `GET /assets/lookup?tag=` | exact asset tag (case-insensitive) or serial |

## Schema workflow

`apps/api/prisma/migrations/*/migration.sql` is the source of truth. After changing the database, run `pnpm --filter @itam/api db:pull` to re-introspect `schema.prisma`. Columns Prisma can't model (`cidr`, `int4range`, `macaddr`) appear as `Unsupported`, and the services use parameterised raw SQL for them.
