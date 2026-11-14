import { useCallback, useEffect, useRef, useState } from "react";

export interface MicState {
  active: boolean;
  error: string | null;
  rms: number;
  peak: number;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Real microphone levels, not a decorative animation. If the browser refuses
 * the microphone the bar says so instead of pretending to listen.
 */
export function useMicLevel(): MicState {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rms, setRms] = useState(0);
  const [peak, setPeak] = useState(0);

  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number>(0);

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setActive(false);
    setRms(0);
    setPeak(0);
  }, []);

  const start = useCallback(async () => {
    if (contextRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      streamRef.current = stream;
      contextRef.current = context;
      setActive(true);
      setError(null);

      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        let max = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const value = buffer[i] ?? 0;
          sum += value * value;
          max = Math.max(max, Math.abs(value));
        }
        const nextRms = Math.sqrt(sum / buffer.length);
        setRms((previous) => previous * 0.7 + nextRms * 0.3);
        setPeak((previous) => Math.max(previous * 0.92, max));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(detail);
      setActive(false);
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { active, error, rms, peak, start, stop };
}

/** Amplitude (0–1) to dBFS, which is what audio meters actually show. */
export function toDb(amplitude: number): number {
  if (amplitude <= 0.00001) return -60;
  return Math.max(-60, 20 * Math.log10(amplitude));
}
