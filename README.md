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
- **Phase 4:**
  - application dependency mapping: TCP sessions collected over SSH become `depends_on` edges, shown on an interactive topology map with blast radius and applications
  - outbound integrations: a transactional outbox feeds HMAC-signed webhooks, Slack, Jira and ServiceNow through a separate dispatcher, with retries, dead letters and replay
  - service-client credentials for the worker: short-lived tokens instead of a long-lived JWT
  - container images for every service, a full-stack compose file and a GitHub Actions pipeline
- **Phase 5:**
  - single sign-on with any OIDC provider (Keycloak, AD FS, Entra ID, Okta); roles and site scopes come from IdP groups
  - global search (names, tags, serials, IPs, CIDRs, MACs, UUIDs), an overview dashboard, and CSV import/export
  - vCenter, AWS and Azure inventory discovery, converging with SSH discovery on the same VM
  - live pages over Server-Sent Events, Prometheus metrics, OpenTelemetry traces, JSON logs, and a Grafana dashboard

See **[docs/architecture.md](docs/architecture.md)** for the system diagram and phase plan.

```
apps/api        NestJS 10 · Prisma 6 · hand-written SQL migrations (prisma/migrations)
apps/web        Next.js 14 App Router · Tailwind · RackElevation component
apps/discovery-worker  BullMQ worker · SNMP (net-snmp) and SSH (ssh2) collectors · lab simulator
packages/shared Zod schemas + TypeScript types shared by API, web and worker
Dockerfile      one multi-target build: api · dispatcher · web · worker · lab
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

# webhook dispatcher (a separate process; scale it horizontally)
pnpm --filter @itam/api dispatcher

# discovery worker: the seed prints WORKER_CLIENT_ID / WORKER_CLIENT_SECRET once
export WORKER_CLIENT_ID=... WORKER_CLIENT_SECRET=...
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

## Run with Docker

```bash
cp .env.example .env        # set JWT_SECRET, VAULT_MASTER_KEY and POSTGRES_PASSWORD
docker compose --profile app build
docker compose --profile app up -d     # migrate runs once, then api, dispatcher, web and worker start

# first run: an admin token for the web app, and credentials for the worker
docker compose exec api node dist/cli.js create-admin --email you@example.com --expires 30d   # → API_TOKEN in .env
docker compose exec api node dist/cli.js create-service-client --name discovery-worker >> .env
docker compose --profile app up -d     # picks up the new .env values

# optional demo hosts (shares the worker's network namespace)
docker compose --profile app --profile lab up -d
```

- **Runtime hardening:** every service runs as the non-root `node` user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. Health checks are built into each image.
- **No downloads at runtime:** the Prisma engines are baked into the image, so `migrate` works offline.
- **Only web (3000) and api (4000) are published.** Postgres and Redis bind to 127.0.0.1 for local development.
- **Behind a TLS-intercepting proxy, build with:** `docker build --secret id=ca,src=ca.pem --build-arg HTTPS_PROXY=...`

## Tests

```bash
# API tests create a throwaway database on any Postgres 16 server you can CREATE DATABASE on
TEST_DATABASE_ADMIN_URL=postgresql://itam:itam@localhost:5432/postgres pnpm test
pnpm typecheck
```

- **`apps/api`, 184 tests:**
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
  - Dependencies:
    - edges derived at run finish (peers found later in the same run resolve)
    - ephemeral, loopback and inbound sessions filtered
    - observations counted once per run
    - graph directions, blast radius, applications
    - manual edges vs stale discovered edges vs power edges
  - Integrations:
    - outbox commits with the change
    - pattern fan-out
    - signed delivery to a real local receiver
    - retry, give-up and replay
    - 4xx dead letters, ping isolation
    - SSRF blocking at send time
    - daily dedupe
  - Service clients: scrypt hashing, token exchange, rotation and revocation killing old tokens, uniform errors, rate limits.
  - SSO and scopes (against the lab IdP's real JWKS):
    - verified, fresh, single-use ID tokens; group → role and site mapping
    - adopting pre-provisioned users
    - writes confined to a user's sites; reads stay global
    - logout and admin revocation
  - Search, reports and CSV:
    - every query shape
    - dashboard aggregates
    - streamed, formula-safe export that re-imports unchanged
    - import with dry run, every row problem reported at once, U collisions between rows, matching by tag then serial
  - Inventory:
    - vSphere job shapes
    - VM → host `runs_on` links (moved on vMotion)
    - SSH and vCenter converging on a byte-swapped SMBIOS UUID
    - endpoint failures
  - Live and observability:
    - only committed changes are streamed, and admin-only events are hidden
    - metrics by route template, with an optional token
    - request ids echoed and stamped on audit rows
- **`apps/discovery-worker`, 31 tests:**
  - against a real in-process SSH server and SNMP agent (v2c and v3 authPriv)
  - `ss`/`netstat` parsing
  - target expansion, credential ordering, batching, stop and shutdown
  - token refresh
  - collectors against a mock vCenter, a mocked EC2 client and a mock Entra ID/ARM server
- **`apps/web`, 12 tests:** rack layout maths, topology layout (deterministic, consumers left of dependencies).
- **CI** (`.github/workflows/ci.yml`):
  - typecheck and all suites against a Postgres 16 service container
  - a production web build
  - every image built, checked to run as non-root and, for the API image, to start with no network access

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

## Phase 4 API

| Route | Who | Notes |
|---|---|---|
| `GET /cmdb/graph?root=&depth=2&direction=up\|down\|both&includeStale=false` | all | nodes with applications; edges with ports, process, last seen, stale flag; capped at 2,000 edges |
| `GET /assets/:id/impact` | all | everything that transitively depends on the asset, and the applications affected |
| `POST /cmdb/relationships`, `DELETE /cmdb/relationships/:id` | admin, network_engineer | manual edges; a discovered edge can be removed only once stale; power edges never |
| `GET/POST /applications`, `GET/PATCH/DELETE /applications/:id`, `PUT /applications/:id/members`, `GET /applications/:id/graph` | read: all; write: admin, network_engineer | |
| `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries`, `POST /webhook-deliveries/:id/replay`, `GET /webhooks/event-types` | admin | secrets are write-only; a generic webhook's signing secret is shown once |
| `POST /auth/token` | public | `{clientId, clientSecret}` → 15-minute bearer token |
| `GET/POST /service-clients`, `POST /service-clients/:id/rotate`, `DELETE /service-clients/:id` | admin | secret shown once; rotation and revocation end existing tokens within 30 s |

### Dependency mapping

- **What is collected:** the SSH inventory also reads listening and established TCP sockets (`ss`, or `netstat` as a fallback).
- **When edges are built:** at the end of each run, once every host's IP is known. Each client-side session becomes `host depends_on server`, with its ports and process name.
- **Which sessions count:** a port counts only if the far host reported it as a listener. If the far host wasn't discovered over SSH, ports in the ephemeral range don't count.
- **Edges are never deleted.** A dependency not seen for 14 days is shown dashed as stale, and only then can someone remove it.
- **Hand-made edges are never touched by discovery.**

### Webhooks

- **Events:**
  - Every audited change emits `<entity>.<action>` (for example `asset.created`) in the same transaction as the change.
  - Further events: `discovery.conflict`, `discovery.run.finished`, `contract.expiring` (inside its notice window, daily) and `maintenance.due`.
- **Subscriptions** match an exact type, `entity.*`, or `*`.
- **Verifying a generic webhook:**
  - The signature header is `X-ITAM-Signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
  - Reject signatures older than 5 minutes.
  - Dedupe on `X-ITAM-Delivery`. Delivery is at-least-once.
- **Retries:** about a day of retries with backoff, and `Retry-After` is honoured. A 4xx response other than 408/429 is not retried.
- **SSRF protection:**
  - Targets must resolve to public addresses; this is checked in the socket's DNS lookup.
  - Redirects are never followed.
  - On-prem targets need `WEBHOOK_ALLOW_PRIVATE_CIDRS`.

## Phase 5

### Single sign-on

- **How sign-in works:**
  - The web server is a confidential OIDC client (authorization code + PKCE).
  - It hands the ID token to `POST /auth/sessions`.
  - The API checks the signature against the issuer's JWKS, plus `iss`, `aud`, `exp` and an age under 5 minutes. Each token can be used once.
  - The API then returns an opaque session. The browser holds only an httpOnly SameSite=Lax cookie.
- **Roles and sites come from groups at every login:**
  - The strongest mapped role wins.
  - A user in no mapped group is refused.
  - A site group that matches no site refuses the login rather than granting every site.
- **Site scopes limit writes:** assets, placement, components, ports, cables, power and maintenance. Reads stay global. Admins can also set scopes by hand (`PUT /users/:id/sites`) and sign a user out everywhere (`DELETE /users/:id/sessions`).

```bash
# local IdP for development (users: Ada admin, Nour network, Dana DC-East tech, Ari auditor, Mallory no groups)
pnpm --filter @itam/api lab-idp
# API
OIDC_ISSUER=http://127.0.0.1:4400 OIDC_CLIENT_ID=itam-web \
OIDC_ROLE_MAP='{"itam-admins":"admin","itam-network":"network_engineer","itam-dc-techs":"dc_technician","itam-auditors":"auditor"}' \
OIDC_SITE_MAP='{"site-dc-east":["DC-East"]}' pnpm --filter @itam/api dev
# web
OIDC_ISSUER=http://127.0.0.1:4400 OIDC_CLIENT_ID=itam-web OIDC_CLIENT_SECRET=lab-secret pnpm --filter @itam/web dev
```

- **Keycloak:** add a "groups" mapper to the client and set `OIDC_SCOPES="openid email profile"`.
- **Entra ID:** set `OIDC_GROUPS_CLAIM=groups` (group object ids are the map keys), or use app roles with `OIDC_GROUPS_CLAIM=roles`.

### Search, dashboard, CSV

| Route | Notes |
|---|---|
| `GET /search?q=` | IP/CIDR → IPAM containment; MAC in any notation, including Cisco dotted; UUID; otherwise exact tag/serial, then name prefix, then trigram similarity |
| `GET /reports/summary` | assets, rack U and power against budget, coverage and expiries, busiest subnets, discovery and webhook health |
| `GET /export/{assets,ip-addresses,subnets,contracts}.csv` | streamed; formula injection neutralised; the asset export uses the import columns |
| `POST /imports/assets?dryRun=true` | `text/csv`; one transaction that rolls back unless clean and committed, so a dry run is exact |

### Inventory discovery

| Protocol | Endpoint | Credential | Least privilege |
|---|---|---|---|
| `vsphere` | `https://vcenter.example.com` (7.0 U2+ REST) | username + password | a read-only role with System.View |
| `aws` | region, for example `eu-west-1` | access key id + secret | `ec2:DescribeInstances`, `ec2:DescribeInstanceTypes` |
| `azure` | subscription id | tenant, client id, client secret | Reader on the subscription |

- **Identity matching:** provider ids are the strongest key. The vCenter BIOS UUID and Azure `vmId` are matched in both SMBIOS byte orders, so SSH discovery of the same guest updates the same asset.
- **VM → host `runs_on` edges** are built at the end of the run and move on vMotion.
- **vCenters with a private CA:** put the CA in `options.tlsCaPem`. `options.tlsInsecure` is for labs only, and the run logs a warning.

### Live updates and observability

- **Live updates:**
  - Committed outbox events and run progress are sent through Postgres `NOTIFY`. Every API replica `LISTEN`s and streams them at `GET /events/stream?types=asset.*,discovery_run.progress` (SSE).
  - Events carry references only, so pages re-read through the permission-checked API.
  - Credential, webhook, session and user events are shown to admins only.
  - If the stream drops, pages fall back to polling and say so.
- **Metrics:**
  - The API serves `GET /api/v1/metrics` (set `METRICS_TOKEN` to require a bearer token).
  - The dispatcher serves `:9464/metrics` and the worker `:9465/metrics`.
  - Latency is labelled by route template, so cardinality stays bounded.
- **Traces:** set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://jaeger:4318`). Spans cover HTTP, Express/Nest, Prisma, Redis and outbound calls.
- **Logs:**
  - `LOG_FORMAT=json` (the default in the images) gives one line per event, with `requestId` and `traceId`.
  - The access log records the route template, never the raw URL.
  - `X-Request-Id` is accepted or minted, echoed on the response, and stored on audit rows.
- **Observability stack:** `docker compose --profile app --profile observability up -d` adds Prometheus (with alert rules), Grafana (the "ITAM platform" dashboard, provisioned) and Jaeger, all bound to 127.0.0.1.

## Schema workflow

`apps/api/prisma/migrations/*/migration.sql` is the source of truth. After changing the database, run `pnpm --filter @itam/api db:pull` to re-introspect `schema.prisma`. Columns Prisma can't model (`cidr`, `int4range`, `macaddr`) appear as `Unsupported`, and the services use parameterised raw SQL for them.
