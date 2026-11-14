# NUMA Build Plan

> Canonical source of truth for implementation phases, stack, testing, and delivery.

**Status:** Active
**Owner:** NUMA project

## Phase 0 — Stabilize the prototype

- Disable unreliable automatic wake actions.
- Remove unwanted global mute/volume behavior.
- Keep push-to-talk as the reliable fallback.
- Enforce truthful YouTube Music responses.
- Add structured action and failure logs.
- Add emergency stop behavior.

## Phase 1 — First verified vertical slice

- Inspect the existing repository and document reusable functionality before changing code.
- Define typed request, response, approval, and event schemas.
- Create the NUMA Gateway and session model.
- Create the Tool Registry and one real Chrome-opening/navigation tool.
- Add a minimal centralized Policy Engine.
- Add execution IDs, idempotency keys, timeouts, cancellation, and structured lifecycle events.
- Execute the tool and perform deterministic verification.
- Persist the result in SQLite and render it through the existing Poni/dashboard surface.
- Preserve one NUMA identity and one active task model.

Acceptance criterion: a real user request completes through policy, execution, verification, audit, and visible activity-result states. No mock-only interfaces.

### Phase 1 status (Gate 1 complete)

Built in `numa-core/gateway/` (TypeScript, port 8900, separate from the
existing `numa-core.mjs` voice core on 8899):

- Gateway: Fastify REST + WebSocket event stream.
- Tool registry with a required `verify` handler.
- Central policy engine (permission levels 0–4, risk, approval).
- Execution IDs, idempotency keys, `AbortSignal` cancellation, timeouts.
- SQLite audit: `executions` + `execution_events`.
- First real tool: `app.launch` (Chrome, Notepad, Explorer) verified by
  process count from the OS.
- 14 tests passing; typecheck clean.
- Verified end to end: `app.launch` opened Notepad, verification reported
  `0 → 2` processes, full lifecycle recorded, replay with the same
  idempotency key returned the same execution without re-running.

Still open in Phase 1: wiring Poni's NUMA page to gateway events instead of
polling, and migrating the Deepgram/voice endpoints out of `numa-core.mjs`.

## Phase 2 — Expand reliability and tools

Expand the Phase 1 foundations with typed tools, approval workflows, recovery, rollback, timeout handling, cancellation, and audit metadata.

Initial tools:

1. Application launcher
2. Window manager
3. YouTube Music
4. Browser
5. Files
6. Clipboard
7. Timers
8. System status

## Phase 3 — Build the fast router

- Deterministic intent matching.
- No-model path for obvious commands.
- Fast local response templates.
- Latency measurement.
- No deep planning for simple media, app, timer, or navigation commands.

Target: common actions under two seconds where external systems allow it.

## Phase 4 — Build the dashboard

- React/Vite/TypeScript application.
- NUMA design tokens and component library.
- Poni notch redesign.
- Command center.
- Conversation workspace.
- Tool activity timeline.
- Approval cards.
- Error/recovery states.
- Electric Night Butterfly asset and state machine.

## Phase 5 — Rebuild voice

- Local wake detector.
- Local VAD.
- Streaming STT.
- Silence-based turn completion.
- Interruptible TTS.
- Voice state synchronized with the dashboard.
- False-trigger and idle testing.

## Phase 6 — Integrate GBrain

- Create the NUMA KnowledgeAdapter.
- Retrieve relevant context before planning.
- Write important durable outcomes after execution.
- Link memories to projects, entities, goals, and decisions.
- Add inspect, edit, forget, and delete controls.

## Phase 7 — Browser and screen control

- Manifest V3 Chrome extension.
- Existing Chrome session access.
- DOM and accessibility extraction.
- Tab and page control.
- Screenshot capture.
- Playwright/CDP fallback.
- Windows UI Automation.
- Windows Graphics Capture.
- OCR and vision context.
- Transparent screen overlays and target highlighting.

## Phase 8 — Business-partner features

- Goals and projects.
- Tasks and blockers.
- Routines and scheduled reviews.
- Experiments and measurements.
- Weekly summaries.
- Proactive suggestions.
- Business research workflows.
- Project memory and decision history.

## Phase 9 — Quality and release

- Rust tests.
- Core unit and integration tests.
- React component tests.
- Playwright end-to-end tests.
- Accessibility tests.
- Visual regression screenshots.
- Permission and emergency-stop tests.
- Voice false-trigger tests.
- Latency benchmarks.
- Windows packaging and signed releases.

## Technology stack

### Desktop

Rust, Poni, `windows-rs`, WASAPI, Windows Graphics Capture, Direct3D 11, Direct2D, DirectComposition, WebView2.

### Core

TypeScript, a supported Node.js LTS runtime, Fastify, WebSocket, Zod, Pino. Select the exact LTS version after checking repository and dependency compatibility; do not couple architecture to an unsupported runtime.

### UI

React, Vite, Tailwind CSS, Radix UI, Framer Motion, Three.js, React Three Fiber, Blender, GLB/glTF, Rive/SVG.

### Browser

Chrome Manifest V3 extension, Playwright, Chrome DevTools Protocol.

### Storage

SQLite, WAL mode, FTS5, typed SQL/Drizzle, append-only event log, Windows Credential Manager.

### AI and voice

Provider-agnostic model adapter, fast routing model, planning model, vision model, optional Ollama/local models, local wake detector, VAD, Deepgram streaming STT/TTS initially, local Whisper/TTS alternatives later.

### Integrations

Google APIs with OAuth 2.0 PKCE, optional Composio adapters, YouTube Music adapter, Telegram Bot API, Chrome extension.

## Definition of done

- Zero unwanted idle actions.
- Critical actions always require approval.
- Meaningful actions are verified.
- Emergency stop interrupts all active control.
- Simple commands are fast.
- Screen context is visible and controllable.
- GBrain memory is inspectable.
- Poni and the dashboard share the NUMA brand.
- The butterfly animation reflects actual system state.
- The interface remains useful when tools fail.

## Required failure tests

- A retry cannot execute the same action twice.
- UI disconnection does not corrupt agent state.
- Late approval cannot revive an expired action.
- Interruption cancels active execution where possible.
- Browser closure is recoverable.
- Chrome extension service-worker reconnect is handled.
- Verification does not rely on an LLM claiming success.
- A crash between action and audit is recoverable or visibly marked uncertain.
- Concurrent requests from multiple interfaces are serialized or explicitly coordinated.
