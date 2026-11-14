import { useEffect, useMemo, useRef, useState } from "react";
import { ArtifactCard } from "./components/ArtifactCard";
import { Composer } from "./components/Composer";
import { CoreLayer } from "./components/CoreLayer";
import { HudNav, type CanvasFilter, type ViewMode } from "./components/HudNav";
import { VoiceBar } from "./components/VoiceBar";
import { STATE_TONE, type ButterflyState } from "./components/Butterfly";
import { useMicLevel } from "./hooks/useMicLevel";
import { useGateway } from "./useGateway";

type Selection = "core" | CanvasFilter;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const gateway = useGateway();
  const mic = useMicLevel();
  const clock = useClock();
  const composerRef = useRef<HTMLDivElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  const derived: ButterflyState = useMemo(() => {
    const list = gateway.executions;
    if (list.some((item) => item.status === "awaiting_approval")) return "approval";
    if (
      list.some(
        (item) =>
          item.status === "running" ||
          item.status === "verifying" ||
          item.status === "policy_checked" ||
          item.status === "created",
      )
    ) {
      return "working";
    }
    if (busy) return "working";
    const latest = list[0];
    if (latest?.status === "failed") return "error";
    if (latest?.status === "succeeded") return "success";
    return "idle";
  }, [gateway.executions, busy]);

  const working = derived === "working" || derived === "approval";

  const mode: ViewMode =
    selection === "core" ? "core" : selection ? "canvas" : working ? "canvas" : "core";

  const filter: CanvasFilter = selection && selection !== "core" ? selection : "all";

  const counts = useMemo(() => {
    const list = gateway.executions;
    return {
      all: list.length,
      running: list.filter((item) => item.status === "running" || item.status === "verifying").length,
      verified: list.filter((item) => item.status === "succeeded").length,
      failed: list.filter((item) => item.status === "failed").length,
    };
  }, [gateway.executions]);

  const visible = useMemo(() => {
    const list = gateway.executions;
    if (filter === "running") {
      return list.filter((item) => item.status === "running" || item.status === "verifying");
    }
    if (filter === "verified") return list.filter((item) => item.status === "succeeded");
    if (filter === "failed") return list.filter((item) => item.status === "failed");
    return list;
  }, [gateway.executions, filter]);

  const detail = useMemo(() => {
    if (error) return error;
    const latest = gateway.executions[0];
    if (!latest) return "";
    if (latest.status === "awaiting_approval") return `${latest.toolId} needs your approval`;
    if (latest.verification?.detail) return latest.verification.detail;
    if (latest.error) return latest.error;
    if (latest.result?.summary) return latest.result.summary;
    return "";
  }, [gateway.executions, error]);

  const run = async (text: string) => {
    setBusy(true);
    setError(null);
    setSelection(null);
    try {
      await gateway.run(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const focusComposer = () => {
    const input = composerRef.current?.querySelector("input");
    input?.focus();
  };

  return (
    <div className={`shell shell--${derived}`} style={{ ["--core" as string]: STATE_TONE[derived].core }}>
      <div className="shell__grid" aria-hidden="true" />
      <div className="shell__vignette" aria-hidden="true" />

      <header className="top">
        <div className="brand">
          <span className="brand__glyph" aria-hidden="true">
            ◈
          </span>
          <span className="brand__word">NUMA</span>
          <span className="brand__sep" aria-hidden="true" />
          <span className="brand__tag">Electric Night Butterfly</span>
        </div>

        <div className="top__right">
          <HudNav
            mode={mode}
            filter={filter}
            counts={counts}
            onSelect={(id) => setSelection(id)}
          />
          <span className={`link ${gateway.connected ? "link--on" : "link--off"}`}>
            <span className="link__dot" aria-hidden="true" />
            {gateway.connected ? "link" : "offline"}
          </span>
          <span className="clock">{clock}</span>
        </div>
      </header>

      <CoreLayer state={derived} mode={mode} detail={detail} />

      <main className={`canvas ${mode === "canvas" ? "is-open" : ""}`} aria-label="Artifacts">
        <div className="canvas__grid">
          {!gateway.ready ? (
            <div className="canvas__blank">Linking to the gateway…</div>
          ) : visible.length === 0 ? (
            <div className="canvas__blank">
              {filter === "all"
                ? "Nothing has run yet. Say “open chrome” and NUMA will launch it, then prove the process exists."
                : `No ${filter} executions.`}
            </div>
          ) : (
            visible.map((execution, index) => (
              <ArtifactCard
                key={execution.id}
                execution={execution}
                index={index}
                onApprove={gateway.approve}
                onCancel={gateway.cancel}
              />
            ))
          )}
        </div>
      </main>

      <div className="dock" ref={composerRef}>
        <Composer onRun={run} busy={busy} />
        {error && (
          <p className="dock__error" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="bottom">
        <VoiceBar mic={mic} onNote={focusComposer} />
        <span className="bottom__meta">
          {counts.verified} verified · {counts.failed} failed · 127.0.0.1:8900
        </span>
      </footer>
    </div>
  );
}
