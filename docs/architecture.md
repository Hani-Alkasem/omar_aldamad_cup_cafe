# Architecture

An IT asset, infrastructure and dependency platform in the spirit of Device42: CMDB, DCIM (rack elevations), IPAM, agentless discovery and application dependency mapping.

## System diagram

```mermaid
flowchart LR
  subgraph Client
    B[Browser<br/>desktop + mobile asset view]
  end

  subgraph Web["apps/web · Next.js App Router"]
    SSR[Server components<br/>rack, asset, subnet pages]
    UI[Client components<br/>RackElevation · Topology graph]
  end

  subgraph API["apps/api · NestJS gateway  /api/v1"]
    REST[REST controllers<br/>OpenAPI at /docs]
    WS[WebSocket gateway<br/>discovery job progress]
    AUTH[JWT guard + RBAC<br/>admin · dc_technician · network_engineer · auditor]
    SVC[Domain services<br/>Assets · RackPlacement · IPAM · CMDB graph]
    AUD[AuditService<br/>before/after diff in same tx]
    VAULT[Credential vault<br/>AES-256-GCM, key from KMS/env]
  end

  subgraph Data
    PG[(PostgreSQL 16<br/>inet/cidr · GiST EXCLUDE · JSONB<br/>recursive CTE graph)]
    RD[(Redis<br/>BullMQ queues)]
  end

  subgraph Workers["Discovery & integration workers"]
    DW[Discovery worker · Python<br/>SNMP v1/v2c/v3 · SSH · WinRM · nmap<br/>AWS · Azure · vSphere]
    REC[Reconciler<br/>dedupe by UUID → serial → MAC]
    WH[Webhook dispatcher<br/>Jira SM · ServiceNow · Slack]
  end

  B --> SSR --> REST
  B --> UI --> REST
  UI <-.-> WS
  REST --> AUTH --> SVC
  SVC --> AUD --> PG
  SVC --> PG
  SVC -- enqueue jobs --> RD
  RD --> DW --> REC -- upsert CIs --> REST
  RD --> WH
  DW -. decrypt creds .-> VAULT
  WS <-. job events .- RD
```

## Phase 1 scope

| Area | Phase 1 | Later |
|---|---|---|
| Gateway | NestJS REST, OpenAPI, JWT RBAC, error mapping | GraphQL, WebSocket job stream |
| Data | Full core DDL, integrity in the database | Neo4j projection for very large graphs |
| Assets | CRUD, U-space collision (app pre-check + DB `EXCLUDE`) | Lifecycle, contracts, depreciation, QR labels |
| IPAM | Subnet create/tree/utilisation, allocate/reserve/release | DNS, DHCP scopes, switch-port MAC mapping |
| DCIM UI | Interactive 42U elevation, front/rear, drag-to-move | Cable/patch-panel views, power telemetry |
| Discovery | Tables only | Workers, scheduler, vault, reconciliation |

## Integrity rules enforced by PostgreSQL

Every rule below holds even if a client bypasses the API:

- **Rack U-space:** `asset_rack_occupancy` has `EXCLUDE USING gist (rack_id WITH =, face WITH =, u_range WITH &&)`. Full-depth devices occupy both faces, half-depth devices one face, zero-U devices none. A trigger keeps the table in sync with `assets` and rejects devices that run past the top of the rack.
- **Subnets:** CIDR is normalised (host bits rejected), duplicates are blocked per VRF, and the parent is resolved automatically as the smallest containing subnet. Children are re-parented when a supernet is inserted.
- **IPs:** must sit inside their subnet, cannot be the network or broadcast address (IPv4 /0–/30), and are unique per VRF.
- **Audit:** `audit_logs` is append-only; UPDATE and DELETE raise.

The API also pre-checks rack placement and CIDR validity so it can return friendly 409/422 bodies. The constraints are the race-proof backstop.
