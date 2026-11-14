import { ButterflyCanvas } from "../three/Butterfly3D";
import { STATE_TONE, type ButterflyState } from "./Butterfly";
import type { ViewMode } from "./HudNav";

const TICKS = 84;

function Ticks() {
  const marks = Array.from({ length: TICKS }, (_, index) => {
    const angle = (index / TICKS) * Math.PI * 2 - Math.PI / 2;
    const major = index % 7 === 0;
    const outer = 208;
    const inner = major ? 195 : 201;
    return {
      key: index,
      x1: 210 + Math.cos(angle) * inner,
      y1: 210 + Math.sin(angle) * inner,
      x2: 210 + Math.cos(angle) * outer,
      y2: 210 + Math.sin(angle) * outer,
      major,
    };
  });

  return (
    <g className="rings__ticks">
      {marks.map((mark) => (
        <line
          key={mark.key}
          x1={mark.x1}
          y1={mark.y1}
          x2={mark.x2}
          y2={mark.y2}
          stroke={mark.major ? "rgba(190,215,255,0.6)" : "rgba(130,160,210,0.26)"}
          strokeWidth={mark.major ? 1.3 : 0.85}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

export function CoreLayer({
  state,
  mode,
  detail,
}: {
  state: ButterflyState;
  mode: ViewMode;
  detail: string;
}) {
  const tone = STATE_TONE[state];

  return (
    <div className={`core ${mode === "canvas" ? "core--shrunk" : ""}`}>
      <div className="core__stage" style={{ ["--core" as string]: tone.core }}>
        <div className="core__bloom" aria-hidden="true" />
        <div className="core__sweep" aria-hidden="true" />

        <svg className="rings" viewBox="0 0 420 420" aria-hidden="true">
          <circle cx="210" cy="210" r="209" className="rings__hair" />
          <circle cx="210" cy="210" r="188" className="rings__dash" />
          <circle cx="210" cy="210" r="150" className="rings__arc" />
          <circle cx="210" cy="210" r="126" className="rings__hair" />
          <Ticks />
        </svg>

        <div className="core__canvas">
          <ButterflyCanvas state={state} />
        </div>
      </div>

      {mode === "core" && (
        <div className="readout">
          <div className="readout__state">
            <span className="readout__dot" aria-hidden="true" />
            {tone.label}
          </div>
          <p className="readout__detail">{detail || tone.caption}</p>
        </div>
      )}
    </div>
  );
}
