// A small colored dot marking a node that a live validation issue concerns
// (red = error, amber = warning; errors win when a node has both). Rendered on
// every node shape branch in node.tsx, paint-only: absolutely positioned just
// outside the node's top-RIGHT corner (the entry badge owns top-LEFT), z-10 so
// it rides above the frame, pointer-events-none so it never intercepts a
// drag/click, aria-hidden since it's a decorative cue. Selection outlines mean
// "selected" — this is deliberately NOT an outline tint, so the two never
// conflict.
//
// `level` is a comparable string ("" / "warning" / "error") so it stays a
// memo-safe Node prop. Kept in its own file (not a local component in node.tsx)
// so node.tsx defines exactly one component — a second component in that module
// trips a React Compiler ref-analysis false-positive on the memoized Node.
export default function IssueDot({ level }: { level: string }) {
    if (level !== "error" && level !== "warning") return null;
    return (
        <span
            aria-hidden
            className={`pointer-events-none absolute -right-1 -top-1 z-10 h-2.5 w-2.5 rounded-full ${
                level === "error" ? "bg-red-500" : "bg-amber-500"
            }`}
        />
    );
}
