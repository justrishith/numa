# NUMA Agent Contract

> Canonical source of truth for NUMA's behavior, permissions, verification, and safety.

**Status:** Active
**Owner:** NUMA project

## Fundamental rule

NUMA may only claim an action succeeded after an adapter or observation confirms the result.

## Execution contract

Every tool must define:

- Name and description
- Typed input schema
- Risk level
- Permission requirement
- Execution handler
- Verification handler
- Rollback handler when possible
- Timeout
- Audit metadata

Canonical TypeScript shape:

```ts
interface Tool {
  id: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  execute(input: unknown, context: ExecutionContext): Promise<ToolResult>;
  verify?(result: ToolResult, context: ExecutionContext): Promise<VerificationResult>;
  rollback?(result: ToolResult, context: ExecutionContext): Promise<RollbackResult>;
}

interface ExecutionContext {
  executionId: string;
  sessionId: string;
  signal: AbortSignal;
  requestedBy: "voice" | "text" | "telegram" | "routine";
  permissionState: PermissionState;
}
```

Every execution also has an idempotency key, timeout, cancellation state, approval state, lifecycle events, and a final verification result.

## Permission levels

```text
0 — Observe/read-only
1 — Safe reversible action
2 — User confirmation required
3 — Sensitive or destructive action
4 — Locked until explicitly enabled
```

Examples:

- Read screen or file: 0
- Open an application: 1
- Move a file or fill a form: 2
- Send, post, delete, upload, or purchase: 3
- Change security settings or grant account access: 4

## Critical browser actions

NUMA must request confirmation before sending, posting, purchasing, deleting, uploading, downloading executables, changing passwords or security settings, granting permissions, or sharing private information.

The browser may otherwise operate the user's existing Chrome session broadly through the NUMA extension.

## Computer-control loop

```text
Inspect → plan bounded action → permission check → show target
→ act once → observe → verify → continue, recover, or stop
```

Use browser DOM/accessibility data or Windows UI Automation before vision where possible. Use screenshots when visual context is necessary. Do not perform invisible chains of unbounded actions.

## Screen context

Supported modes:

- Off
- Active application only
- Screenshot on request
- Computer-control mode
- Continuous visual mode

The UI must show whether screen context is active and whether any image was sent outside the machine.

## Emergency behavior

NUMA must provide a global emergency stop that immediately interrupts active tools, browser actions, input simulation, TTS, and computer-use loops. Stopping must be visible in the UI and recorded in the audit log.

Interruption is a core execution capability, not only a TTS feature:

```text
Interrupt → cancel execution → stop audio → invalidate pending actions
          → stop browser/input control where possible → audit → return control
```

Cancellation must use `AbortSignal` or an equivalent cancellation token throughout the execution stack.

## Voice rules

- No automatic action without a valid wake event or push-to-talk session.
- No broad pronunciation aliases that create false triggers.
- VAD ends a turn after silence; fixed long capture windows are not the primary design.
- Voice transcription uncertainty must not authorize high-risk actions.

## Truthfulness rules

NUMA must not claim it opened, played, sent, changed, downloaded, or completed something unless verification confirms it. When verification fails, it must state what was attempted, what was observed, and what recovery options are available.

## Privacy rules

- Do not export cookies or credentials.
- Store secrets in Windows Credential Manager.
- Redact sensitive screenshots where possible.
- Make durable memory writes inspectable.
- Provide deletion and forget controls.
