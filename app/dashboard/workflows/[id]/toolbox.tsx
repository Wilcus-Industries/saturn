"use client";

import { useState } from "react";
import McpLogo from "@/app/dashboard/mcpLogo";
import {
    CATALOG,
    CATEGORY_STYLES,
    type CatalogEntry,
    type NodeCategory,
    type WorkflowGraph,
} from "@/lib/workflow";
import EntryIcon from "./entryIcon";

const SECTIONS: { category: NodeCategory; heading: string }[] = [
    { category: "main", heading: "main functions" },
    { category: "saturn", heading: "agents" },
    { category: "mcp", heading: "mcp servers" },
    { category: "skill", heading: "skills" },
];

type SpawnStart = (key: string, clientX: number, clientY: number) => void;

function Chip({
    entry,
    enabled,
    borderL,
    onSpawnStart,
}: {
    entry: CatalogEntry;
    enabled: boolean;
    borderL: string;
    onSpawnStart: SpawnStart;
}) {
    return (
        <div
            className={`flex touch-none items-center gap-2 border border-foreground/15 border-l-2 px-2 py-1.5 transition-colors duration-200 ${borderL} ${
                enabled
                    ? "cursor-grab hover:bg-foreground/5"
                    : "cursor-not-allowed opacity-40"
            }`}
            // drag-spawn: capture the pointer here so nothing else reacts
            // mid-drag; the designer tracks the ghost chip via window
            // listeners and drops the node on pointerup over the canvas
            onPointerDown={
                enabled
                    ? (e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          onSpawnStart(entry.key, e.clientX, e.clientY);
                      }
                    : undefined
            }
        >
            <EntryIcon entry={entry} />
            <span className={"truncate"}>{entry.label}</span>
        </div>
    );
}

export default function Toolbox({
    graph,
    userCatalog,
    onSpawnStart,
}: {
    graph: WorkflowGraph;
    userCatalog: CatalogEntry[];
    onSpawnStart: SpawnStart;
}) {
    const hasStart = graph.nodes.some((n) => n.type === "start");

    // registered servers can carry dozens of tools each — filter by node
    // label or server name
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const matches = (entry: CatalogEntry) =>
        !q ||
        entry.label.toLowerCase().includes(q) ||
        (entry.group ?? "").toLowerCase().includes(q);

    return (
        <aside
            className={
                "flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-foreground/15 bg-background p-3 font-mono text-xs"
            }
        >
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={"search nodes…"}
                aria-label={"search nodes"}
                className={
                    "border border-foreground/15 bg-background px-2 py-1.5 font-mono text-xs"
                }
            />
            {SECTIONS.map(({ category, heading }) => {
                const styles = CATEGORY_STYLES[category];

                // mcp: one chip per enabled tool, grouped under a server
                // subheader (the hidden legacy per-server entries are skipped)
                if (category === "mcp") {
                    const groups = new Map<string, CatalogEntry[]>();
                    for (const entry of userCatalog) {
                        if (entry.category !== "mcp" || entry.legacy || !matches(entry)) continue;
                        const group = entry.group ?? entry.label;
                        const list = groups.get(group);
                        if (list) list.push(entry);
                        else groups.set(group, [entry]);
                    }
                    return (
                        <section key={category} className={"flex flex-col gap-1.5"}>
                            <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                                {heading}
                            </h2>
                            {groups.size === 0 && (
                                <p className={"text-[10px] text-gray-400"}>
                                    {q ? "no matches" : "none yet — add in settings"}
                                </p>
                            )}
                            {[...groups].map(([server, entries]) => (
                                <div key={server} className={"flex flex-col gap-1"}>
                                    <div
                                        className={
                                            "flex items-center gap-1.5 text-[10px] text-gray-400"
                                        }
                                    >
                                        {entries[0].logoDomain && (
                                            <McpLogo
                                                domain={entries[0].logoDomain}
                                                name={server}
                                                size={16}
                                            />
                                        )}
                                        <span className={"truncate"}>{server}</span>
                                    </div>
                                    <div className={"flex flex-col gap-1 pl-3"}>
                                        {entries.map((entry) => (
                                            <Chip
                                                key={entry.key}
                                                entry={entry}
                                                enabled
                                                borderL={styles.borderL}
                                                onSpawnStart={onSpawnStart}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </section>
                    );
                }

                const entries = [
                    ...CATALOG.filter((entry) => entry.category === category),
                    // user registry entries follow the static ones
                    ...userCatalog.filter((entry) => entry.category === category),
                ].filter(matches);
                return (
                    <section key={category} className={"flex flex-col gap-1.5"}>
                        <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                            {heading}
                        </h2>
                        {category === "skill" && entries.length > 0 && (
                            <p className={"text-[10px] text-gray-400"}>
                                not runnable in test runs yet
                            </p>
                        )}
                        {entries.length === 0 && (
                            <p className={"text-[10px] text-gray-400"}>
                                {q ? "no matches" : "none yet — add in settings"}
                            </p>
                        )}
                        {entries.map((entry) => (
                            <Chip
                                key={entry.key}
                                entry={entry}
                                enabled={!(entry.key === "start" && hasStart)}
                                borderL={styles.borderL}
                                onSpawnStart={onSpawnStart}
                            />
                        ))}
                    </section>
                );
            })}
        </aside>
    );
}
