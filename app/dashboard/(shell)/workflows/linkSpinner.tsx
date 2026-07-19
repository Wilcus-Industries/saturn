"use client";

import { useLinkStatus } from "next/link";
import Spinner from "@/app/dashboard/spinner";

// spinner shown while the enclosing <Link>'s navigation is pending
// (must stay a descendant of the Link — useLinkStatus reads it)
export default function LinkSpinner({ className }: { className?: string }) {
    const { pending } = useLinkStatus();
    if (!pending) return null;

    return (
        <span className={`nav-pending-show ${className ?? ""}`}>
            <Spinner />
        </span>
    );
}
