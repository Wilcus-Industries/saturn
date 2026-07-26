"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import type { RegistryEntryRow } from "@/lib/registry";
import { relativeTime } from "../../workflows/workflowCard";
import { DeleteItemButton, WipeStoreButton } from "./itemButtons";

type MemoryItemRow = { id: string; content: string; created_at: number };

// browse and manage one memory store's items
function MemoryStore() {
    const id = useSearchParams().get("id") ?? "";
    // ponytail: the filter is local state, not `?q=` — a search is no longer
    // bookmarkable or back-buttonable the way the old GET form's was. Lift it
    // into the url with router.replace if anyone misses that.
    const [draft, setDraft] = useState("");
    const [query, setQuery] = useState("");

    const load = useCallback(
        () =>
            Promise.all([
                call<RegistryEntryRow[]>("list_registry"),
                call<MemoryItemRow[]>("list_memory_items", { entryId: id, q: query }),
                call<Record<string, number>>("count_memory_items"),
            ]),
        [id, query],
    );
    const { data, error, loading, reload } = useAsync(load);

    const [registry, items, counts] = data ?? [];
    const store = registry?.find((entry) => entry.id === id && entry.kind === "memory");
    const total = counts?.[id] ?? 0;

    return (
        <div className={"flex flex-col gap-6"}>
            <Link
                href={"/dashboard/memory/"}
                className={`font-mono text-sm text-gray-400 underline underline-offset-4
                    transition-colors duration-200 hover:text-foreground`}
            >
                ← memory
            </Link>

            {loading && <Loading what={"loading store"} />}
            {error && <ErrorNote error={error} retry={reload} />}
            {data && !store && (
                <p className={"font-mono text-sm text-gray-400"}>no such memory store</p>
            )}

            {store && items && (
                <>
                    <div className={"flex flex-wrap items-baseline gap-x-3 gap-y-1"}>
                        <h1 className={"font-mono text-3xl"}>
                            {store.emoji} {store.name}
                        </h1>
                        <span className={"font-mono text-sm text-gray-400"}>
                            {total} {total === 1 ? "memory" : "memories"}
                        </span>
                    </div>

                    {store.description && (
                        <p className={"font-mono text-sm whitespace-pre-wrap text-gray-400"}>
                            {store.description}
                        </p>
                    )}

                    <div className={"flex flex-wrap items-center gap-3"}>
                        {/* submit-only: typing must not fire a query per keystroke */}
                        <form
                            action={() => setQuery(draft)}
                            className={"flex flex-1 items-center gap-2"}
                        >
                            <input
                                name={"q"}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder={"search memories"}
                                className={`min-w-0 flex-1 border border-foreground/15 bg-background p-2
                                    font-mono text-sm`}
                            />
                            <button
                                type={"submit"}
                                className={`rounded-full border border-foreground px-4 py-2 font-mono text-sm
                                    transition-colors duration-200 hover:bg-foreground hover:text-background`}
                            >
                                search →
                            </button>
                            {query && (
                                <button
                                    type={"button"}
                                    onClick={() => {
                                        setDraft("");
                                        setQuery("");
                                    }}
                                    className={"font-mono text-sm text-blue-400"}
                                >
                                    clear
                                </button>
                            )}
                        </form>

                        {total > 0 && <WipeStoreButton id={id} onWiped={reload} />}
                    </div>

                    {items.length === 0 && (
                        <p className={"font-mono text-sm text-gray-400"}>
                            {query
                                ? "no memories match your search"
                                : "nothing remembered yet — the agent fills this in as it runs"}
                        </p>
                    )}

                    <div className={"flex flex-col gap-3"}>
                        {items.map((item) => (
                            <div
                                key={item.id}
                                className={"flex items-start gap-3 border border-foreground/15 p-4"}
                            >
                                <div className={"flex min-w-0 flex-1 flex-col gap-1"}>
                                    <p className={"font-mono text-sm whitespace-pre-wrap"}>
                                        {item.content}
                                    </p>
                                    <span className={"font-mono text-xs text-gray-400"}>
                                        {relativeTime(item.created_at)}
                                    </span>
                                </div>
                                <DeleteItemButton id={item.id} onDeleted={reload} />
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

// useSearchParams needs a Suspense boundary to prerender under `output: export`
export default function MemoryStorePage() {
    return (
        <Suspense fallback={<Loading what={"loading store"} />}>
            <MemoryStore />
        </Suspense>
    );
}
