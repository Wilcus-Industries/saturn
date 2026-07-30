"use client";

// Which workflow the designer has open — module state, not a route param, and
// that is the whole reason it exists.
//
// The designer is mounted by `(shell)/layout.tsx`, not by its own route, so that
// switching nav tabs HIDES it instead of unmounting it: an App Router page is
// torn down on every navigation, and with it the undo history, the canvas
// viewport, the selection, the console and the agent panel's width. None of that
// is in the database and none of it is worth persisting; keeping the subtree
// alive is cheaper than reconstructing it. The route's `page.tsx` is reduced to
// a registrar that writes the `?id=` here, and the layout's host reads it.
//
// Same shape as `agentChatStore.ts` — a module `let`, a listener Set and a
// `useSyncExternalStore` triple — because there is no React context anywhere in
// this app and this is the pattern that replaced it.

/// `nonce` counts opens, and it is load-bearing rather than diagnostic.
/// `designer.tsx` takes the "open in designer →" handoff in an effect keyed on
/// the workflow id. Once the designer stops unmounting, a SECOND handoff to the
/// workflow already on screen is not an id change, so that effect would never
/// re-run and the agent panel would silently fail to open. Counting the opens is
/// what makes "arrive here again" observable when the destination didn't move.
export type Open = { id: string; nonce: number };

// Nothing open. Also the prerender snapshot: this module is client-only, so the
// exported HTML always shows no designer (a fresh load has none anyway).
const CLOSED: Open = { id: "", nonce: 0 };

// One object, replaced and never mutated — `useSyncExternalStore` compares
// snapshots by identity, so an in-place `open.nonce++` would render nothing.
let open: Open = CLOSED;

const listeners = new Set<() => void>();
const emit = () => {
    for (const l of listeners) l();
};

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

export const getOpen = (): Open => open;
export const serverOpen = (): Open => CLOSED;

/// Arriving at the designer route. Always emits, even for the id already open —
/// see the `nonce` note above.
export function openDesigner(id: string): void {
    open = { id, nonce: open.nonce + 1 };
    emit();
}

/// Tear the designer down for real. Callers are the two places a workflow gets
/// deleted — the designer's own topbar and the list page's card — because a
/// hidden designer left mounted against a deleted row keeps its autosave retry
/// loop running forever against a `save_workflow` that can only fail (and the
/// Workflows chip keeps pointing at it).
///
/// `id`-matched: deleting workflow B from the list must not close a designer
/// holding workflow A.
export function closeDesigner(id: string): void {
    if (open.id !== id) return;
    open = CLOSED;
    emit();
}
