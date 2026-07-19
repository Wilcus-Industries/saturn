"use client";

import { type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import Spinner from "./spinner";

// submit button that turns into a spinner while its form's server action runs
// (useFormStatus only reports the enclosing form, so sibling cards stay idle)
export default function ActionButton({
    className,
    children,
}: {
    className: string;
    children: ReactNode;
}) {
    const { pending } = useFormStatus();

    return (
        <button className={className} type={"submit"} disabled={pending} aria-busy={pending}>
            {pending ? <Spinner /> : children}
        </button>
    );
}
