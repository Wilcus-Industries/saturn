"use client";

import { useRef } from "react";
import ProviderLogo from "@/app/dashboard/providerLogos";
import { call } from "@/lib/ipc";
import SecretForm from "./secretForm";

// what `provider_status` returns, one row per provider, in the backend's order
export type ProviderStatus = { id: string; name: string; enabled: boolean };

// hardcoded in Rust too (providers.rs) — there is no port setting to read
const CC_ORIGIN = "127.0.0.1:8787";

const CODE = "bg-foreground/10 px-1 font-mono text-xs";
const HINT = "font-mono text-xs text-gray-400";

function ClaudeCodeBody({ enabled, reload }: { enabled: boolean; reload: () => void }) {
    return (
        <div className={"flex flex-col gap-3 font-mono text-sm"}>
            <p className={HINT}>
                Claude Code runs through a small local server that speaks the OpenAI API and
                drives your <code className={CODE}>claude</code> CLI. It uses your existing{" "}
                <code className={CODE}>claude login</code> — there is no API key and no
                per-token billing.
            </p>

            <ol className={"flex list-decimal flex-col gap-2 pl-5 text-xs"}>
                <li>
                    install the <code className={CODE}>claude</code> CLI and run{" "}
                    <code className={CODE}>claude login</code>
                </li>
                <li>
                    clone{" "}
                    <code className={CODE}>github.com/schmarta/claude-code-openai-server</code>
                </li>
                <li>
                    <code className={CODE}>uv sync</code> (it is Python/uv, not npm)
                </li>
                <li>
                    <code className={CODE}>
                        uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
                    </code>
                </li>
            </ol>

            <p className={HINT}>
                Saturn expects it at <code className={CODE}>http://{CC_ORIGIN}/v1</code>. That
                address is hardcoded.
            </p>

            <p className={"font-mono text-xs text-red-400"}>
                Keep it on loopback. The server drives Claude with{" "}
                <code className={CODE}>bypassPermissions</code>, so anyone who can reach the
                port runs arbitrary code as you.
            </p>

            <p className={"flex items-center gap-3 font-mono text-xs"}>
                <span className={enabled ? "text-green-400" : "text-gray-400"}>
                    {enabled ? "connected" : `not detected on ${CC_ORIGIN}`}
                </span>
                <button
                    type={"button"}
                    // force a fresh probe before refetching: the page's own read
                    // would otherwise be answered from the 30s cache, which is
                    // exactly the stale answer this button exists to escape
                    onClick={async () => {
                        await call("provider_status", { refresh: true }).catch(() => {});
                        reload();
                    }}
                    className={"text-blue-400 underline underline-offset-4"}
                >
                    re-check
                </button>
            </p>
        </div>
    );
}

// The tile for one provider plus its connection modal.
//
// Not ModalShell: that wraps its children in its own <form>, and the OpenRouter
// body is SecretForm, which is a <form>. Nesting them is invalid HTML, and
// re-implementing SecretForm's write-only convention here to fit ModalShell's
// action would put the "blank means keep" rule in two places. A native <dialog>
// gives the same backdrop, Escape-to-close and focus trap with no state at all.
export default function ProviderModal({
    provider,
    reload,
}: {
    provider: ProviderStatus;
    reload: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);

    return (
        <>
            {/* a real button with visible text as its name; the greyed-out look is
                never the disabled attribute — the modal is where you go to fix
                being disconnected */}
            <button
                type={"button"}
                onClick={() => ref.current?.showModal()}
                // fixed width so the squares sit on one pitch: without it each
                // tile is as wide as its own label and the icons come out ragged
                className={`flex w-20 flex-col items-center gap-2 p-1 focus-visible:outline-2
                    focus-visible:outline-offset-2 focus-visible:outline-foreground`}
            >
                <span
                    className={`flex h-14 w-14 items-center justify-center rounded-[22%] border
                        border-foreground/15 bg-foreground/5 transition-colors duration-200
                        hover:bg-foreground/10
                        ${provider.enabled ? "" : "opacity-40 grayscale"}`}
                >
                    <ProviderLogo id={provider.id} name={provider.name} className={"h-8 w-8"} />
                </span>
                {/* same treatment as the toolbox's ModelChip label: a name
                    longer than the tile wraps rather than widening it */}
                <span
                    className={"w-full break-words text-center font-mono text-xs leading-tight"}
                >
                    {provider.name}
                </span>
            </button>

            <dialog
                ref={ref}
                // only a click on the dialog box itself is a backdrop click; the
                // panel below carries the padding so nothing inside can hit this
                onClick={(e) => {
                    if (e.target === ref.current) ref.current?.close();
                }}
                className={`m-auto w-full max-w-md border border-foreground/15 bg-background
                    p-0 text-foreground backdrop:bg-background/80`}
            >
                <div className={"flex flex-col gap-4 p-6"}>
                    <h2 className={"font-mono text-xl"}>{provider.name}</h2>

                    {provider.id === "claude-code" ? (
                        <ClaudeCodeBody enabled={provider.enabled} reload={reload} />
                    ) : (
                        <>
                            <p className={HINT}>
                                create a key at openrouter.ai/keys — it funds every model call
                            </p>
                            <SecretForm
                                field={"openrouter api key"}
                                placeholder={"sk-or-..."}
                                isSet={provider.enabled}
                                cmd={"set_openrouter_key"}
                                onSaved={() => {
                                    reload();
                                    ref.current?.close();
                                }}
                            />
                        </>
                    )}
                </div>
            </dialog>
        </>
    );
}
