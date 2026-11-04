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
- **Phase 3:**
  - agentless discovery over SNMP v2c/v3 and SSH, run by a separate worker service on BullMQ
  - a credential vault (AES-256-GCM, secrets never returned by the API)
  - scheduled and on-demand jobs
  - reconciliation into the CMDB by system UUID → serial → MAC → IP, with conflicts held for review

See **[docs/architecture.md](docs/architecture.md)** for the system diagram and phase plan.

```
apps/api        NestJS 10 · Prisma 6 · hand-written SQL migrations (prisma/migrations)
apps/web        Next.js 14 App Router · Tailwind · RackElevation component
apps/discovery-worker  BullMQ worker · SNMP (net-snmp) and SSH (ssh2) collectors · lab simulator
packages/shared Zod schemas + TypeScript types shared by API, web and worker
```

## Quick start

```bash
cp .env.example .env                 # set JWT_SECRET (32+ chars) and VAULT_MASTER_KEY (openssl rand -base64 32)
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

# discovery worker (a separate process; scale it horizontally)
export WORKER_TOKEN=$(pnpm --silent --filter @itam/api token --role discovery_service --expires 30d)
pnpm --filter @itam/discovery-worker dev

# no network gear? three SSH servers and an SNMP switch on loopback:
pnpm --filter @itam/discovery-worker lab    # SSH :2222 on 127.0.0.11-13 (discovery / lab-password), SNMP 127.0.0.20:1161 (lab-ro)
```

### Try discovery against the lab

```bash
H="Authorization: Bearer $(pnpm --silent --filter @itam/api token --role admin)"; U=http://localhost:4000/api/v1
curl -sH "$H" -H 'content-type: application/json' $U/subnets -d '{"cidr":"127.0.0.0/24","name":"Lab"}'
C=$(curl -sH "$H" -H 'content-type: application/json' $U/credentials \
  -d '{"name":"Lab Linux","kind":"ssh_password","username":"discovery","secret":{"password":"lab-password"}}' | jq -r .id)
curl -sH "$H" -H 'content-type: application/json' $U/discovery/jobs -d "{\"name\":\"Lab servers\",\"protocol\":\"ssh\",
  \"targets\":[\"127.0.0.8/29\"],\"credentialIds\":[\"$C\"],\"scheduleCron\":\"0 3 * * *\",\"options\":{\"port\":2222}}"
# then open http://localhost:3000/discovery and press Run now (the web token must be admin or network_engineer)
```

## Tests

```bash
# API tests create a throwaway database on any Postgres 16 server you can CREATE DATABASE on
TEST_DATABASE_ADMIN_URL=postgresql://itam:itam@localhost:5432/postgres pnpm test
pnpm typecheck
```

- **`apps/api`, 103 tests:**
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
  - Discovery:
    - the vault (fresh IVs, tamper and row-swap detection, key rotation); no secret in any response or audit row
    - target, credential-kind and schedule validation; one active run per job
    - service account confined to internal routes; credential hand-out audited as `access`
    - reconciliation: creates, idempotent retries, NIC-moved and host-key-change conflicts, accepting a new key
    - enqueue only after commit, compensation when Redis is down; lease re-claim and the sweeper
- **`apps/discovery-worker`, 19 tests:** against a real in-process SSH server and SNMP agent (v2c and v3 authPriv), plus target expansion, credential ordering, batching, stop and shutdown.
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

## Discovery

```
web ─POST /discovery/jobs/:id/run─▶ API ──commit run row──▶ Postgres
                                     └──enqueue {runId} (after commit)──▶ Redis/BullMQ ──▶ worker
worker ─claim─▶ API: run → running, lease 120 s, decrypted credentials returned over this HTTPS call only
worker ─probe hosts (bounded concurrency)─▶ SNMP / SSH
worker ─POST hosts every 5 s (also the heartbeat)─▶ API reconciler ─▶ assets, ports, components, IPAM, audit
worker ─finish─▶ API
```

- **Secrets:**
  - They never touch Redis, logs or audit rows.
  - The master key lives only in the API's environment.
  - Ciphertext is bound to its row id and kind, so it can't be moved to another row.
  - `VAULT_PREVIOUS_KEYS` keeps old rows readable during a key rotation.
- **Worker transport:** the worker refuses a plain-HTTP API outside loopback.
- **Exactly one run per job:**
  - A partial unique index enforces it.
  - A run whose worker dies is re-claimed once its lease lapses, or failed by the sweeper.
  - Retried batches don't double-count.
- **Nothing is merged silently.** These are recorded as `conflict`, and the asset is left untouched:
  - hardware keys that point at different assets
  - a serial that doesn't match the asset's stored serial
  - a changed SSH host key, until someone accepts it with `DELETE /assets/:id/discovery/ssh-host-key`
- **Discovery never overwrites hand-curated data.**
  - It only fills in identifiers the asset lacks.
  - It only replaces components it created itself.
  - It never deletes ports.
- **The SSH inventory is read-only.**
  - It is one POSIX `sh` exec: no writes, no package managers.
  - DMI identity fields fall back to passwordless `sudo -n` and are skipped when that isn't allowed.

| Route | Who |
|---|---|
| `GET/POST /credentials`, `PUT /credentials/:id/secret`, `DELETE /credentials/:id` | admin |
| `GET/POST /discovery/jobs`, `GET/PATCH/DELETE /discovery/jobs/:id`, `POST /discovery/jobs/:id/run` | read: all; write: admin, network_engineer |
| `GET /discovery/jobs/:id/runs`, `GET /discovery/runs/:id`, `GET /discovery/runs/:id/results?outcome=` | all |
| `DELETE /assets/:id/discovery/ssh-host-key` | admin, dc_technician |
| `POST /internal/discovery/{jobs/:id/runs, runs/:id/claim, runs/:id/hosts, runs/:id/finish}` | `discovery_service` only |

## Schema workflow

`apps/api/prisma/migrations/*/migration.sql` is the source of truth. After changing the database, run `pnpm --filter @itam/api db:pull` to re-introspect `schema.prisma`. Columns Prisma can't model (`cidr`, `int4range`, `macaddr`) appear as `Unsupported`, and the services use parameterised raw SQL for them.
