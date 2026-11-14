import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RiskLevel = "low" | "medium" | "high";
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;
export type RequestedBy = "voice" | "text" | "telegram" | "routine";

export type ExecutionStatus =
  | "created"
  | "policy_checked"
  | "awaiting_approval"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExecutionRow {
  id: string;
  idempotency_key: string | null;
  session_id: string;
  tool_id: string;
  requested_by: RequestedBy;
  input_json: string;
  status: ExecutionStatus;
  risk: RiskLevel;
  permission_level: number;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  verification_json: string | null;
  error: string | null;
  created_at: string;
}

export interface ExecutionEventRow {
  id: number;
  execution_id: string;
  type: string;
  payload_json: string | null;
  at: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  session_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL,
  permission_level INTEGER NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  verification_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(created_at DESC);

CREATE TABLE IF NOT EXISTS execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_events_execution
  ON execution_events(execution_id, id);
`;

const COLUMNS = `id, idempotency_key, session_id, tool_id, requested_by, input_json,
  status, risk, permission_level, approved_at, started_at, finished_at,
  result_json, verification_json, error, created_at`;

export interface NewExecution {
  id: string;
  idempotencyKey: string | null;
  sessionId: string;
  toolId: string;
  requestedBy: RequestedBy;
  inputJson: string;
  risk: RiskLevel;
  permissionLevel: PermissionLevel;
  createdAt: string;
}

export interface ExecutionPatch {
  status?: ExecutionStatus;
  approvedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  resultJson?: string | null;
  verificationJson?: string | null;
  error?: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  createExecution(execution: NewExecution): ExecutionRow {
    this.db
      .prepare(
        `INSERT INTO executions (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        execution.id,
        execution.idempotencyKey,
        execution.sessionId,
        execution.toolId,
        execution.requestedBy,
        execution.inputJson,
        "created",
        execution.risk,
        execution.permissionLevel,
        execution.createdAt,
      );
    const row = this.getExecution(execution.id);
    if (!row) throw new Error("execution row vanished after insert");
    return row;
  }

  getExecution(id: string): ExecutionRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM executions WHERE id = ?`)
      .get(id) as unknown as ExecutionRow | undefined;
  }

  findByIdempotencyKey(key: string): ExecutionRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM executions WHERE idempotency_key = ?`)
      .get(key) as unknown as ExecutionRow | undefined;
  }

  listExecutions(limit = 50): ExecutionRow[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM executions ORDER BY created_at DESC LIMIT ?`)
      .all(bounded) as unknown as ExecutionRow[];
  }

  updateExecution(id: string, patch: ExecutionPatch): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null | undefined) => {
      if (value === undefined) return;
      fields.push(`${column} = ?`);
      values.push(value);
    };
    set("status", patch.status);
    set("approved_at", patch.approvedAt);
    set("started_at", patch.startedAt);
    set("finished_at", patch.finishedAt);
    set("result_json", patch.resultJson);
    set("verification_json", patch.verificationJson);
    set("error", patch.error);
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE executions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  appendEvent(executionId: string, type: string, payload: unknown, at: string): void {
    this.db
      .prepare(
        `INSERT INTO execution_events (execution_id, type, payload_json, at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(executionId, type, payload === undefined ? null : JSON.stringify(payload), at);
  }

  listEvents(executionId: string): ExecutionEventRow[] {
    return this.db
      .prepare(
        `SELECT id, execution_id, type, payload_json, at
         FROM execution_events WHERE execution_id = ? ORDER BY id`,
      )
      .all(executionId) as unknown as ExecutionEventRow[];
  }

  close(): void {
    this.db.close();
  }
}
