"use client";

import { useEffect, useState, useTransition } from "react";
import { getOrCreateWebhookSecret, rotateWebhookSecret } from "./actions";
import PopoverShell from "./popoverShell";

// fixed-position popover anchored under an event:webhook trigger circle: shows
// the workflow's ingress URL with copy + regenerate controls. Uses the shared
// PopoverShell (measure-and-clamp positioning + backdrop that freezes canvas
// events and closes on click). Touches no graph state — the secret lives in a
// workflow column, not the node config, so there's no undo coalescing here.
export default function WebhookPopover({
    anchor,
    workflowId,
    base,
    secret,
    onSecret,
    onClose,
}: {
    anchor: { x: number; y: number };
    workflowId: string;
    base: string; // "<baseUrl>/api/hooks"
    secret: string | null; // null until provisioned
    onSecret: (secret: string) => void; // lift the minted/rotated secret to the designer
    onClose: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // auto-provision on open when the workflow has no secret yet
    useEffect(() => {
        if (secret !== null) return;
        startTransition(async () => {
            try {
                onSecret(await getOrCreateWebhookSecret(workflowId));
            } catch {
                setError("could not create url");
            }
        });
        // run once on mount — a later secret change comes from our own onSecret
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const url = secret ? `${base}/${workflowId}/${secret}` : "";

    const copy = () => {
        if (!url) return;
        navigator.clipboard.writeText(url).then(
            () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            },
            () => setError("could not copy"),
        );
    };

    const regenerate = () => {
        setError(null);
        startTransition(async () => {
            try {
                onSecret(await rotateWebhookSecret(workflowId));
            } catch {
                setError("could not regenerate url");
            }
        });
    };

    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={
                "flex w-72 flex-col gap-2 border border-foreground/15 bg-background p-3 font-mono text-xs shadow-lg"
            }
        >
            <span className={"font-semibold"}>{"webhook url"}</span>

            {secret === null ? (
                <p className={"text-[11px] text-gray-400"}>
                    {pending ? "creating url…" : (error ?? "no url yet")}
                </p>
            ) : (
                <>
                    <div
                        className={
                            "select-all break-all rounded border border-foreground/15 bg-foreground/5 p-2 text-[11px] text-gray-300"
                        }
                    >
                        {url}
                    </div>
                    <div className={"flex items-center gap-2"}>
                        <button
                            type={"button"}
                            onClick={copy}
                            className={
                                "rounded border border-foreground/20 px-2 py-1 text-[11px] hover:bg-foreground/10"
                            }
                        >
                            {copied ? "copied" : "copy"}
                        </button>
                        <button
                            type={"button"}
                            onClick={regenerate}
                            disabled={pending}
                            className={
                                "rounded border border-foreground/20 px-2 py-1 text-[11px] hover:bg-foreground/10 disabled:opacity-50"
                            }
                        >
                            {pending ? "…" : "regenerate url"}
                        </button>
                    </div>
                    {error && <p className={"text-[10px] text-red-400"}>{error}</p>}
                    <p className={"text-[10px] text-gray-500"}>
                        {"send a POST request to this url to trigger the workflow."}
                    </p>
                    <p className={"text-[10px] text-gray-500"}>
                        {"regenerating stops the old url from working."}
                    </p>
                    <p className={"text-[10px] text-amber-400/80"}>
                        {"anyone with the url can trigger this workflow, rotate it if it leaks."}
                    </p>
                </>
            )}
        </PopoverShell>
    );
}
