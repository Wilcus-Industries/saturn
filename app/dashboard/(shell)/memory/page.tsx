"use client";

import Link from "next/link";
import ConfirmButton from "@/app/dashboard/confirmButton";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import type { RegistryEntryRow } from "@/lib/registry";
import MemoryModal from "./memoryModal";

// module-level so it is stable for useAsync — nothing here depends on props
const load = () =>
    Promise.all([
        call<RegistryEntryRow[]>("list_registry"),
        call<Record<string, number>>("count_memory_items"),
    ]);

// persistent agent-memory stores
export default function Memory() {
    const { data, error, loading, reload } = useAsync(load);
    const stores = (data?.[0] ?? []).filter((entry) => entry.kind === "memory");
    const counts = data?.[1] ?? {};

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Memory</h1>

            <p className={"font-mono text-sm text-gray-400"}>
                memory stores give agents a durable place to remember facts across runs. attach
                one to an agent node in the workflow designer to grant it memory.
            </p>

            {loading && <Loading what={"loading stores"} />}
            {error && <ErrorNote error={error} retry={reload} />}

            {data && stores.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no memory stores yet — create one to get started
                </p>
            )}

            <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
                {stores.map((entry) => {
                    const count = counts[entry.id] ?? 0;
                    return (
                        <div
                            key={entry.id}
                            className={`flex min-h-40 flex-col gap-2 border border-foreground/15 p-4
                                transition-colors duration-200 hover:border-foreground/40`}
                        >
                            <div className={"flex items-start gap-3"}>
                                <span className={"text-2xl"}>{entry.emoji}</span>
                                <Link
                                    href={`/dashboard/memory/store/?id=${entry.id}`}
                                    className={"min-w-0 flex-1 font-mono text-sm hover:underline"}
                                >
                                    <span className={"block truncate"}>{entry.name}</span>
                                </Link>
                            </div>

                            {entry.description && (
                                <p
                                    className={`line-clamp-3 font-mono text-xs whitespace-pre-wrap
                                        text-gray-400`}
                                >
                                    {entry.description}
                                </p>
                            )}

                            <div
                                className={`mt-auto flex items-center gap-3 border-t
                                    border-foreground/15 pt-2 font-mono text-xs text-gray-400`}
                            >
                                <Link
                                    href={`/dashboard/memory/store/?id=${entry.id}`}
                                    className={"hover:text-foreground"}
                                >
                                    {count} {count === 1 ? "memory" : "memories"} →
                                </Link>
                                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                    <MemoryModal entry={entry} onSaved={reload} />
                                    <ConfirmButton
                                        id={entry.id}
                                        // only throws on a malformed id; a row that
                                        // is already gone resolves false, and either
                                        // way the refetch shows the truth
                                        action={async () => {
                                            await call("delete_registry_entry", {
                                                id: entry.id,
                                            }).catch(() => {});
                                            reload();
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <MemoryModal onSaved={reload} />
        </div>
    );
}
