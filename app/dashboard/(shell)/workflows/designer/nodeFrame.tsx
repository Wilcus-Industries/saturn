"use client";

// A node box must never carry its frame as a real `border`: geometry.ts anchors
// ports on the BORDER box (node.x/node.y), but absolutely-positioned children
// anchor to the PADDING box, so a border silently pushes every marker inward by
// its width and grows the box past nodeHeight() — the edge then stops short of
// its port. NodeFrame paints the frame as an inset overlay instead, leaving the
// box's own metrics untouched. Lives in its own file because a second component
// in node.tsx trips a react-hooks/refs false positive.
//
// `accent` is the category color (CATEGORY_STYLES.edge) for the top border;
// omit it for a plain frame and pass the accent as a className (e.g. the
// generic rect's border-l-2) instead.
export default function NodeFrame({
    accent,
    className = "",
}: {
    accent?: string;
    className?: string;
}) {
    return (
        <div
            aria-hidden
            style={accent ? { borderTopColor: accent } : undefined}
            className={`pointer-events-none absolute inset-0 border border-foreground/25 ${
                accent ? "border-t-2" : ""
            } ${className}`}
        />
    );
}
