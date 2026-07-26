// A small amber entry-point cue rendered on every event-category node (the
// schedule circle and the rectangular extension-event nodes): a workflow begins
// at its event node, so this marks "start here" the same way regardless of the
// node's shape, without reshaping either. Paint-only — absolutely positioned
// just outside the node's top-left corner, pointer-events-none so it never
// intercepts a drag/click, aria-hidden since it's a purely decorative cue.
//
// Kept in its own file (not a local component in node.tsx) so node.tsx defines
// exactly one component — a second component in that module trips a React
// Compiler ref-analysis false-positive on the memoized Node.
export default function EntryBadge() {
    return (
        <span
            aria-hidden
            className={
                "pointer-events-none absolute -left-1.5 -top-1.5 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[8px] leading-none text-white"
            }
        >
            {/* ▶'s mass leans left; nudge right to optically center it */}
            <span className={"translate-x-[0.5px]"}>{"▶"}</span>
        </span>
    );
}
