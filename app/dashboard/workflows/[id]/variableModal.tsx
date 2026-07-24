"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ActionButton from "@/app/dashboard/actionButton";
import { deleteVariable, saveVariable } from "./actions";

// one variable the toolbox lists. secret = the write-only mode (value never
// reaches the client; hasValue mirrors the registry's derived has_token). For a
// regular (non-secret) variable the value IS viewable/editable, so value carries
// the plaintext; for secrets it is ''.
export type VariableRow = {
    id: string;
    name: string;
    secret: boolean;
    hasValue: boolean;
    value: string;
};

// add/edit modal for one variable, opened from the toolbox's variables split.
// Controlled by the toolbox (target = existing row, or "new"). Follows the
// settings skillModal conventions: controlled inputs (React resets uncontrolled
// fields after a form action, which would wipe input on an error return), inline
// error from the action's { error } result. A secret checkbox picks the mode at
// creation only (locked on edit — flipping could reveal a write-only secret):
// secret = write-only value field (blank keeps, checkbox clears); regular = a
// plaintext value field, prefilled + editable. Success closes + router.refresh()
// so the server page re-reads the invalidated registry.
export default function VariableModal({
    target,
    onClose,
}: {
    target: VariableRow | "new";
    onClose: () => void;
}) {
    const router = useRouter();
    const editing = target === "new" ? null : target;
    // mode fixed at creation: new variables default to regular (unchecked); an
    // existing row keeps its stored mode and the checkbox is disabled below.
    const [secret, setSecret] = useState(editing?.secret ?? false);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState(editing?.name ?? "");
    // regular variables are viewable — prefill from the stored plaintext; secrets
    // stay write-only so their field always starts blank
    const [value, setValue] = useState(editing && !editing.secret ? editing.value : "");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Escape closes; listener only lives while the modal is open
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const onDelete = async () => {
        if (!editing) return;
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        setDeleting(true);
        const formData = new FormData();
        formData.set("id", editing.id);
        const result = await deleteVariable(formData);
        if (result) {
            setError(result.error);
            setDeleting(false);
            setConfirmDelete(false);
            return;
        }
        onClose();
        router.refresh();
    };

    return (
        <div
            className={"fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"}
            onClick={onClose}
        >
            {/* clicks inside the panel must not reach the backdrop */}
            <div
                className={"w-full max-w-md border border-foreground/15 bg-background p-6"}
                onClick={(e) => e.stopPropagation()}
            >
                <form
                    action={async (formData) => {
                        setError(null);
                        const result = await saveVariable(formData);
                        if (result) {
                            setError(result.error);
                            return;
                        }
                        onClose();
                        router.refresh();
                    }}
                    className={"flex flex-col gap-4"}
                >
                    <h2 className={"font-mono text-xl"}>
                        {editing ? "edit variable" : "new variable"}
                    </h2>
                    <p className={"font-mono text-xs text-gray-400"}>
                        {secret
                            ? "the value is stored server-side and never shown again — nodes carry only an opaque placeholder, resolved inside app actions at run time"
                            : "a plain variable — viewable and editable here; nodes still carry an opaque placeholder, resolved inside app actions at run time"}
                    </p>

                    {editing && <input type={"hidden"} name={"id"} value={editing.id} />}

                    <label className={"flex flex-col gap-1"}>
                        <span className={"font-mono text-xs text-gray-400"}>name</span>
                        <input
                            name={"name"}
                            required
                            autoFocus
                            maxLength={60}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                        />
                    </label>

                    {/* mode picked once at creation; locked on edit (see comment above) */}
                    <label
                        className={`flex items-center gap-2 font-mono text-xs ${
                            editing ? "text-gray-500" : "text-gray-400"
                        }`}
                    >
                        <input
                            type={"checkbox"}
                            name={"secret"}
                            checked={secret}
                            disabled={!!editing}
                            onChange={(e) => setSecret(e.target.checked)}
                        />
                        secret (write-only, never revealed)
                    </label>

                    <label className={"flex flex-col gap-1"}>
                        <span className={"font-mono text-xs text-gray-400"}>value</span>
                        <input
                            name={"value"}
                            type={secret ? "password" : "text"}
                            required={!editing}
                            autoComplete={"off"}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            placeholder={
                                secret && editing?.hasValue
                                    ? "•••• value set — leave blank to keep"
                                    : ""
                            }
                            className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                        />
                    </label>

                    {secret && editing?.hasValue && (
                        <label className={"flex items-center gap-2 font-mono text-xs text-gray-400"}>
                            <input type={"checkbox"} name={"clearValue"} />
                            clear stored value
                        </label>
                    )}

                    {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}

                    <div className={"flex items-center justify-between"}>
                        {editing ? (
                            <button
                                type={"button"}
                                onClick={onDelete}
                                disabled={deleting}
                                className={`font-mono text-xs transition-colors duration-200 ${
                                    confirmDelete ? "text-red-400" : "text-gray-400 hover:text-red-400"
                                }`}
                            >
                                {confirmDelete ? "click again to delete" : "delete"}
                            </button>
                        ) : (
                            <span />
                        )}
                        <ActionButton
                            className={`self-end rounded-full border border-foreground px-4 py-2
                                font-mono text-sm transition-colors duration-200
                                hover:bg-foreground hover:text-background`}
                        >
                            {editing ? "save →" : "add →"}
                        </ActionButton>
                    </div>
                </form>
            </div>
        </div>
    );
}
