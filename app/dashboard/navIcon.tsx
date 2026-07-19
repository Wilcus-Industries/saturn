"use client";

import { useLinkStatus } from "next/link";
import type { IconType } from "react-icons";
import Spinner from "./spinner";

// nav link icon that swaps to a spinner while the navigation is pending.
// Must stay a descendant of <Link> — useLinkStatus reads the enclosing Link.
// The overlay swap keeps the icon box's size, so nothing shifts (and the
// collapsed sidebar, where the icon is all that's visible, works for free).
export default function NavIcon({ icon: Icon, className }: { icon: IconType; className: string }) {
    const { pending } = useLinkStatus();

    return (
        <span className={`relative flex shrink-0 items-center justify-center ${className}`}>
            <Icon className={`h-full w-full ${pending ? "nav-pending-hide" : ""}`} />
            {pending && (
                <span className={"nav-pending-show absolute inset-0 flex items-center justify-center"}>
                    <Spinner />
                </span>
            )}
        </span>
    );
}
