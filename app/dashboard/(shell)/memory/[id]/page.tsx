import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { countMemoryItems, listMemoryItems, MAX_MEMORY_ITEMS } from "@/lib/memory.server";
import { getUserRegistry } from "@/lib/registry.server";
import { getSessionCached } from "@/lib/subscription";
import { relativeTime } from "../../workflows/workflowCard";
import { DeleteItemButton, WipeStoreButton } from "./itemButtons";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// browse and manage one memory store's items; session + ownership checked here
export default async function MemoryStore({
    params,
    searchParams,
}: PageProps<"/dashboard/memory/[id]">) {
    const { id } = await params;
    // pre-validate before querying — junk ids would throw pg 22P02, not miss
    if (!UUID.test(id)) notFound();

    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    // ownership: the store must exist, be a memory kind, and belong to the user
    const registry = await getUserRegistry(session.user.id);
    const store = registry.find((entry) => entry.id === id && entry.kind === "memory");
    if (!store) notFound();

    const { q } = await searchParams;
    const query = typeof q === "string" ? q : "";

    const [items, counts] = await Promise.all([
        listMemoryItems(id, session.user.id, query),
        countMemoryItems(session.user.id),
    ]);
    const total = counts.get(id) ?? 0;

    return (
        <div className={"flex flex-col gap-6"}>
            <Link
                href={"/dashboard/memory"}
                className={`font-mono text-sm text-gray-400 underline underline-offset-4
                    transition-colors duration-200 hover:text-foreground`}
            >
                ← memory
            </Link>

            <div className={"flex flex-wrap items-baseline gap-x-3 gap-y-1"}>
                <h1 className={"font-mono text-3xl"}>
                    {store.emoji} {store.name}
                </h1>
                <span className={"font-mono text-sm text-gray-400"}>
                    {total} / {MAX_MEMORY_ITEMS}
                </span>
            </div>

            {store.description && (
                <p className={"font-mono text-sm whitespace-pre-wrap text-gray-400"}>
                    {store.description}
                </p>
            )}

            <div className={"flex flex-wrap items-center gap-3"}>
                {/* GET form: submitting sets ?q= and re-renders with the filter */}
                <form method={"get"} className={"flex flex-1 items-center gap-2"}>
                    <input
                        name={"q"}
                        defaultValue={query}
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
                        <Link
                            href={`/dashboard/memory/${id}`}
                            className={"font-mono text-sm text-blue-400"}
                        >
                            clear
                        </Link>
                    )}
                </form>

                {total > 0 && <WipeStoreButton id={id} />}
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
                            <p className={"font-mono text-sm whitespace-pre-wrap"}>{item.content}</p>
                            <span className={"font-mono text-xs text-gray-400"}>
                                {relativeTime(item.created_at)}
                            </span>
                        </div>
                        <DeleteItemButton id={item.id} entryId={id} />
                    </div>
                ))}
            </div>
        </div>
    );
}
