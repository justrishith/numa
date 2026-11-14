# NUMA Gateway

Gate 1 of the NUMA build: one real request executed through the complete
permission, event, verification, cancellation, and audit pipeline.

This package is **separate from `../numa-core.mjs`** on purpose. The existing
core still serves Poni's voice path on `127.0.0.1:8899`; the gateway runs on
`127.0.0.1:8900` until that path is migrated. Do not run two competing agents —
this is the new brain under construction, not a second one.

## What exists

```text
POST /v1/executions
  → Tool Registry
  → Policy Engine
  → Execution ID + idempotency key
  → Tool execution (AbortSignal + timeout)
  → Deterministic verification
  → SQLite audit (executions + execution_events)
  → WebSocket event broadcast
```

| Piece | File |
| --- | --- |
| HTTP/WS server | `src/server.ts` |
| Policy engine | `src/policy.ts` |
| Tool contract + registry | `src/registry.ts` |
| Execution engine | `src/execution.ts` |
| SQLite store | `src/db.ts` |
| Event bus | `src/events.ts` |
| First tool (`app.launch`) | `src/tools/app-launch.ts` |

## Run

```bash
cd numa-core/gateway
npm install
npm start
```

Environment:

| Variable | Default |
| --- | --- |
| `NUMA_GATEWAY_PORT` | `8900` |
| `NUMA_DB_PATH` | `%LOCALAPPDATA%\NUMA\numa.db` |
| `NUMA_LOG_LEVEL` | `info` |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | gateway, db, tool count |
| GET | `/v1/tools` | registered tools with risk and permission level |
| POST | `/v1/executions` | run a tool |
| GET | `/v1/executions` | recent executions |
| GET | `/v1/executions/:id` | one execution |
| GET | `/v1/executions/:id/events` | its lifecycle events |
| POST | `/v1/executions/:id/approve` | approve a pending action |
| POST | `/v1/executions/:id/cancel` | cancel a pending/running action |
| WS | `/v1/events` | live lifecycle events |

## Execution request

```json
{
  "toolId": "app.launch",
  "input": { "app": "notepad" },
  "sessionId": "local",
  "requestedBy": "text",
  "idempotencyKey": "optional-dedupe-key"
}
```

## Lifecycle events

```text
execution.created
policy.checked
approval.required      (when the policy demands confirmation)
approval.granted
tool.started
tool.completed
verification.completed
execution.succeeded | execution.failed | execution.cancelled
```

## Rules enforced here

- A tool cannot be registered without a `verify` handler.
- `result.ok` alone never produces success; verification must also pass.
- Permission level 4 is denied regardless of approval.
- Permission levels 2–3 and high-risk actions return `awaiting_approval`.
- The same idempotency key never executes a tool twice.
- Tool timeouts and cancellation abort through `AbortSignal`.

## Test

```bash
npm test        # policy + execution lifecycle, idempotency, approval, cancel
npm run typecheck
```

## Not built yet

Chrome extension, browser adapter, screen context, GBrain adapter, React
dashboard, voice migration, and the 3D butterfly. Those are later gates in
`NUMA_BUILD_PLAN.md`.
