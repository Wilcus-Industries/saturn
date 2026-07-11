"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        if (!pending) return;
        const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
        return () => clearInterval(id);
    }, [pending]);

    return (
        <button className={className} type={"submit"} disabled={pending} aria-busy={pending}>
            {pending ? FRAMES[frame] : children}
        </button>
    );
}
