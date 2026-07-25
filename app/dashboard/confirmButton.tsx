"use client";

import { useEffect, useState } from "react";

// two-step inline confirm: first click arms, second submits the form (with a
// hidden `id`); disarms after 3s. Shared by the shell's delete buttons —
// pass the async action that IPCs the delete and, optionally, the labels.
export default function ConfirmButton({
    id,
    action,
    label = "delete",
    confirm = "confirm?",
    title,
}: {
    id: string;
    action: (formData: FormData) => void | Promise<void>;
    label?: string;
    confirm?: string;
    title?: string;
}) {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    if (!armed) {
        return (
            <button
                type={"button"}
                onClick={() => setArmed(true)}
                className={"font-mono text-sm text-gray-400 hover:text-red-500"}
            >
                {label}
            </button>
        );
    }

    return (
        <form action={action}>
            <input type={"hidden"} name={"id"} value={id} />
            <button
                type={"submit"}
                title={title}
                className={`border border-red-500 px-2 font-mono text-sm transition-colors
                    duration-200 hover:bg-red-600 hover:text-white`}
            >
                {confirm}
            </button>
        </form>
    );
}
