import { useState } from "react";

const SUGGESTIONS = ["Open Chrome", "Open Notepad", "Open Explorer"];

export function Composer({
  onRun,
  busy,
}: {
  onRun: (text: string) => Promise<void>;
  busy: boolean;
}) {
  const [text, setText] = useState("");

  const submit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setText("");
    await onRun(trimmed);
  };

  return (
    <div className="composer">
      <form
        className="composer__field"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text);
        }}
      >
        <span className="composer__wave" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Speak or type a command…"
          aria-label="Command"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="composer__send" disabled={busy || !text.trim()}>
          {busy ? "Working" : "Send"}
        </button>
      </form>

      <div className="composer__chips">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => void submit(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
