import type { Execution, ExecutionStatus } from "../types";

const STAGE: Record<ExecutionStatus, number> = {
  created: 1,
  policy_checked: 2,
  awaiting_approval: 2,
  running: 3,
  verifying: 4,
  succeeded: 5,
  failed: 5,
  cancelled: 5,
};

const LABEL: Record<ExecutionStatus, string> = {
  created: "queued",
  policy_checked: "policy checked",
  awaiting_approval: "awaiting approval",
  running: "running",
  verifying: "verifying",
  succeeded: "verified",
  failed: "failed",
  cancelled: "cancelled",
};

const TONE: Record<ExecutionStatus, string> = {
  created: "muted",
  policy_checked: "muted",
  awaiting_approval: "warn",
  running: "info",
  verifying: "info",
  succeeded: "good",
  failed: "bad",
  cancelled: "muted",
};

const BLOCKS = 26;

function stamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ArtifactCard({
  execution,
  index,
  onApprove,
  onCancel,
}: {
  execution: Execution;
  index: number;
  onApprove: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const tone = TONE[execution.status];
  const filled = Math.round((STAGE[execution.status] / 5) * BLOCKS);
  const pending = execution.status === "awaiting_approval";
  const active = execution.status === "running" || execution.status === "verifying";
  const span = [5, 4, 3, 4, 5, 3, 4][index % 7] ?? 4;

  return (
    <article
      className={`art art--${tone}`}
      style={{
        gridColumn: `span ${span}`,
        animationDelay: `${Math.min(index, 12) * 55}ms`,
      }}
    >
      <header className="art__head">
        <span className="art__kind">{execution.toolId}</span>
        <span className="art__status">{LABEL[execution.status]}</span>
      </header>

      <div className="art__blocks" aria-hidden="true">
        {Array.from({ length: BLOCKS }, (_, block) => (
          <span key={block} className={`art__block ${block < filled ? "is-on" : ""}`} />
        ))}
      </div>

      <p className="art__body">
        {execution.verification?.detail ??
          execution.result?.summary ??
          execution.error ??
          "No output recorded."}
      </p>

      <footer className="art__foot">
        <span className="art__meta">
          {stamp(execution.createdAt)} · {execution.requestedBy} · L{execution.permissionLevel}
        </span>

        {pending && (
          <span className="art__actions">
            <button type="button" className="mini mini--go" onClick={() => void onApprove(execution.id)}>
              Approve
            </button>
            <button type="button" className="mini" onClick={() => void onCancel(execution.id)}>
              Cancel
            </button>
          </span>
        )}

        {active && (
          <button type="button" className="mini" onClick={() => void onCancel(execution.id)}>
            Stop
          </button>
        )}
      </footer>
    </article>
  );
}
