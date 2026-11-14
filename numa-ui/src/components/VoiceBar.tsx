import { toDb, type MicState } from "../hooks/useMicLevel";

const BARS = 28;
const MULTIPLIERS = Array.from({ length: BARS }, (_, index) => {
  const wave = Math.sin((index / BARS) * Math.PI);
  const jitter = ((index * 37) % 11) / 11;
  return 0.35 + wave * 0.65 + jitter * 0.25;
});

export function VoiceBar({
  mic,
  onNote,
}: {
  mic: MicState;
  onNote: () => void;
}) {
  const rmsDb = toDb(mic.rms);
  const peakDb = toDb(mic.peak);

  return (
    <div className="voice">
      <button
        type="button"
        className={`voice__live ${mic.active ? "is-live" : ""}`}
        onClick={() => (mic.active ? mic.stop() : void mic.start())}
        title={mic.active ? "Stop listening" : "Start listening"}
      >
        <span className="voice__dot" aria-hidden="true" />
        {mic.active ? "Live" : "Mic off"}
      </button>

      <div className="voice__meters">
        <div className="voice__meter">
          <span className="voice__meter-label">rms</span>
          <span className="voice__meter-track">
            <span
              className="voice__meter-fill"
              style={{ width: `${Math.min(100, Math.max(0, (rmsDb + 60) * 1.66))}%` }}
            />
          </span>
          <span className="voice__meter-db">{rmsDb.toFixed(1)}</span>
        </div>
        <div className="voice__meter">
          <span className="voice__meter-label">peak</span>
          <span className="voice__meter-track">
            <span
              className="voice__meter-fill voice__meter-fill--peak"
              style={{ width: `${Math.min(100, Math.max(0, (peakDb + 60) * 1.66))}%` }}
            />
          </span>
          <span className="voice__meter-db">{peakDb.toFixed(1)}</span>
        </div>
      </div>

      <div className="voice__wave" aria-hidden="true">
        {MULTIPLIERS.map((multiplier, index) => (
          <i
            key={index}
            style={{
              height: `${Math.max(2, Math.min(18, mic.rms * 46 * multiplier + 2))}px`,
            }}
          />
        ))}
      </div>

      {mic.error && <span className="voice__error">mic blocked</span>}

      <button type="button" className="voice__note" onClick={onNote}>
        Note
      </button>
    </div>
  );
}
