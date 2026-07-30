"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { openDesigner } from "./openStore";

// This route renders NOTHING. The designer itself is mounted by
// `(shell)/layout.tsx` so that navigating to another nav tab hides it instead of
// unmounting it — see `openStore.ts` for why that is worth the indirection.
//
// What is left here is the half a route still has to do: the id rides the query
// string (a static export cannot enumerate a uuid segment), and the address bar
// is the only place it lives. Handing it to the store on arrival is the whole
// job. The layout cannot read it instead — by the time the user is on another
// tab the query string is gone, and that is exactly when the designer has to
// stay open.
function Register() {
    const id = useSearchParams().get("id") ?? "";
    // an effect, not a render-time call: writing to an external store during
    // render tears the host's snapshot away mid-pass
    useEffect(() => void openDesigner(id), [id]);
    return null;
}

// useSearchParams needs a Suspense boundary to prerender under output: "export"
export default function WorkflowDesigner() {
    return (
        <Suspense>
            <Register />
        </Suspense>
    );
}
