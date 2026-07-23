import Link from "next/link";
import { redirect } from "next/navigation";
import { countMemoryItems, MAX_MEMORY_ITEMS } from "@/lib/memory.server";
import { getUserRegistry } from "@/lib/registry.server";
import { getSessionCached } from "@/lib/subscription";
import DeleteMemoryButton from "./deleteMemoryButton";
import MemoryModal from "./memoryModal";

// persistent agent-memory stores; session check lives here, not the layout
export default async function Memory() {
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    const [registry, counts] = await Promise.all([
        getUserRegistry(session.user.id),
        countMemoryItems(session.user.id),
    ]);
    const stores = registry.filter((entry) => entry.kind === "memory");

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Memory</h1>

            <p className={"font-mono text-sm text-gray-400"}>
                memory stores give agents a durable place to remember facts across runs. attach
                one to an agent node in the workflow designer to grant it memory.
            </p>

            {stores.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no memory stores yet — create one to get started
                </p>
            )}

            <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
                {stores.map((entry) => {
                    const count = counts.get(entry.id) ?? 0;
                    return (
                        <div
                            key={entry.id}
                            className={`flex min-h-40 flex-col gap-2 border border-foreground/15 p-4
                                transition-colors duration-200 hover:border-foreground/40`}
                        >
                            <div className={"flex items-start gap-3"}>
                                <span className={"text-2xl"}>{entry.emoji}</span>
                                <Link
                                    href={`/dashboard/memory/${entry.id}`}
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
                                    href={`/dashboard/memory/${entry.id}`}
                                    className={"hover:text-foreground"}
                                >
                                    {count} / {MAX_MEMORY_ITEMS}{" "}
                                    {count === 1 ? "memory" : "memories"} →
                                </Link>
                                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                    <MemoryModal entry={entry} />
                                    <DeleteMemoryButton id={entry.id} />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <MemoryModal />
        </div>
    );
}
