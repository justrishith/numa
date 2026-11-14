# NUMA Architecture

> Canonical source of truth for NUMA's system boundaries and data flow.

**Status:** Active
**Owner:** NUMA project

## System overview

```text
Poni notch/voice ─┐
NUMA dashboard ───┼──> NUMA Gateway ──> NUMA Agent Core
Telegram ────────┘                              │
                                                ├─ Fast router
                                                ├─ Planner
                                                ├─ Tool registry
                                                ├─ Permissions
                                                ├─ Verifier/recovery
                                                ├─ Projects/routines
                                                └─ Memory coordinator
                                                       │
                    ┌──────────────────────────────────┼──────────────────┐
                    ▼                                  ▼                  ▼
             Local tools                       Browser tools       Computer tools
             apps/files/media                  Chrome extension    screen/input/apps
                                                Playwright/CDP
                                                       │
                                                       ▼
                                      Local memory + GBrain knowledge
```

## Component ownership

### Poni native shell

Rust-based native Windows shell. Owns the notch, microphone lifecycle, audio playback, global hotkeys, native overlays, process/window integration, screen capture primitives, and emergency stop.

### NUMA Gateway

Owns interface normalization, sessions, identity, routing requests from Poni, the dashboard, the Chrome extension, and Telegram, and publishing live events.

### NUMA Agent Core

Owns intent routing, planning, tools, permissions, verification, recovery, project state, routines, and task orchestration. It is the only agent brain.

The internal boundaries are grouped into five areas:

```text
Runtime      — gateway, sessions, event bus
Intelligence — model router, planner, verifier
Execution    — tools, permissions, computer control, integrations
Knowledge    — memory, projects, GBrain adapter
Automation   — routines and scheduled tasks
```

These are code boundaries, not separate services. V1 should avoid unnecessary process or package fragmentation.

### GBrain adapter

Retrieves durable context before planning and writes important durable outcomes after execution. GBrain must not independently execute computer actions.

## Execution lanes

```text
Instant lane: deterministic local tools, no model required
Fast lane: lightweight routing and concise conversation
Agent lane: planning, research, projects, and multi-step work
Computer lane: screen-aware browser and desktop control
```

## Request flow

```text
Input → session resolution → fast routing
     → deterministic tool OR planner
     → permission check
     → execute one bounded step
     → observe and verify
     → recover, request approval, or complete
     → record event and durable memory when appropriate
```

## Communication

- REST or JSON-RPC for request/response operations.
- WebSocket events for live state and progress.
- Zod/JSON schemas for every boundary message.
- Local authenticated transport through localhost or named pipes.

The core owns agent and execution state. Poni, the dashboard, Telegram, and the Chrome extension are clients that render or submit state; they must not become competing sources of truth.

## Execution lifecycle

```text
request → execution.created → policy.checked → approval.required?
→ tool.started → tool.progress → tool.completed → verification.completed
→ execution.succeeded | execution.failed | execution.cancelled
```

Every lifecycle has an `executionId`, session ID, timestamp, cancellation state, and audit record. The event bus is shared by all interfaces.

## Technology stack

- Rust, existing Poni shell, `windows-rs`, WASAPI, Windows Graphics Capture, WebView2.
- TypeScript, Node.js 20+, Fastify, WebSocket, Zod, Pino.
- React, Vite, Tailwind CSS, Radix UI, Framer Motion.
- Three.js/React Three Fiber for the 3D butterfly; Blender and GLB/glTF for assets.
- SQLite, FTS5, typed SQL/Drizzle, append-only event log.
- Chrome Manifest V3 extension as primary browser bridge.
- Playwright/CDP as advanced browser fallback.
- Google APIs/Composio for structured account integrations.
- GBrain adapter for durable knowledge.

## Data boundaries

Secrets belong in Windows Credential Manager. Active session state belongs locally in NUMA. Durable project and entity knowledge belongs in GBrain when the user permits it. Browser control uses the user's existing Chrome session through the extension and must not silently export credentials or cookies.
