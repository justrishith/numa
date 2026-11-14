export type ViewMode = "core" | "canvas";
export type CanvasFilter = "all" | "running" | "verified" | "failed";

const ITEMS: { id: "core" | CanvasFilter; label: string }[] = [
  { id: "core", label: "Core" },
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "verified", label: "Verified" },
  { id: "failed", label: "Failed" },
];

export function HudNav({
  mode,
  filter,
  counts,
  onSelect,
}: {
  mode: ViewMode;
  filter: CanvasFilter;
  counts: Record<CanvasFilter, number>;
  onSelect: (id: "core" | CanvasFilter) => void;
}) {
  return (
    <nav className="nav" aria-label="View">
      {ITEMS.map((item) => {
        const active =
          item.id === "core" ? mode === "core" : mode === "canvas" && filter === item.id;
        const count = item.id === "core" ? undefined : counts[item.id];
        return (
          <button
            key={item.id}
            type="button"
            className={`nav__pill ${active ? "is-active" : ""}`}
            aria-pressed={active}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
            {count !== undefined && <span className="nav__count">{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}
