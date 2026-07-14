"use client";

import { useState } from "react";
import type { IconType } from "react-icons";
import { FaBrain, FaCubes, FaPlug, FaRobot } from "react-icons/fa6";
import McpLogo from "@/app/dashboard/mcpLogo";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/lib/openrouter.server";
import {
    CATALOG,
    CATALOG_BY_KEY,
    CATEGORY_STYLES,
    type CatalogEntry,
    type NodeCategory,
} from "@/lib/workflow";
import EntryIcon from "./entryIcon";
import ModelLogo from "./modelLogo";

const SECTIONS: { category: NodeCategory; heading: string }[] = [
    { category: "events", heading: "events" },
    { category: "logic", heading: "logic" },
    { category: "data", heading: "data" },
    { category: "saturn", heading: "agents" },
    { category: "integration", heading: "integrations" },
    { category: "mcp", heading: "tools" },
    { category: "skill", heading: "skills" },
    { category: "model", heading: "openrouter models" },
];

// the 8 catalog categories collapse into 4 selectable toolbox groups, each a
// tab icon at the top; only the active group's SECTIONS render below
const GROUPS: { id: string; label: string; Icon: IconType; categories: NodeCategory[] }[] = [
    { id: "blocks", label: "Blocks", Icon: FaCubes, categories: ["events", "logic", "data"] },
    { id: "integrations", label: "Apps", Icon: FaPlug, categories: ["integration"] },
    { id: "agents", label: "Agents", Icon: FaRobot, categories: ["saturn", "mcp", "skill"] },
    { id: "models", label: "Models", Icon: FaBrain, categories: ["model"] },
];

// preset: chip-supplied initial node config + ghost label (openrouter model
// chips spawn a "model" node with config.model prefilled; preset: "1" marks
// the spawned node's name read-only)
type SpawnPreset = { config: Record<string, string>; label?: string };
type SpawnStart = (key: string, clientX: number, clientY: number, preset?: SpawnPreset) => void;

// grid cell for one openrouter model: 48px logo circle over a truncated name
function ModelChip({
    model,
    onSpawnStart,
}: {
    model: OpenrouterModel;
    onSpawnStart: SpawnStart;
}) {
    // openrouter display names lead with the company ("OpenAI: GPT-4o") —
    // the logo already says it, so show only the model part in the cell
    const shortName = model.name.slice(model.name.indexOf(":") + 1).trim();
    return (
        <div
            title={model.name}
            className={
                "flex touch-none cursor-grab flex-col items-center gap-1 py-1 transition-colors duration-200 hover:bg-foreground/5"
            }
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                onSpawnStart("model", e.clientX, e.clientY, {
                    config: { model: model.id, preset: "1" },
                    label: model.name,
                });
            }}
        >
            <span
                className={`flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-foreground/15 ${CATEGORY_STYLES.model.headerBg}`}
            >
                <ModelLogo slug={model.id} name={model.name} size={48} />
            </span>
            <span className={"line-clamp-2 w-full break-words text-center text-[10px] leading-tight"}>
                {shortName}
            </span>
        </div>
    );
}

// grid cell for one mcp tool grant chip: rounded-square favicon tile over a
// 2-line name, mirroring ModelChip (the per-server "All tools" chip stays a Chip row)
function McpToolChip({
    entry,
    onSpawnStart,
    compact,
}: {
    entry: CatalogEntry;
    onSpawnStart: SpawnStart;
    // compact = the 4-col per-tool grid (smaller tile + font); the "All tools"
    // chip stays full-size on its own row
    compact?: boolean;
}) {
    return (
        <div
            title={entry.label}
            className={
                "flex touch-none cursor-grab flex-col items-center gap-1 py-1 transition-colors duration-200 hover:bg-foreground/5"
            }
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                // the entry key (mcp:<uuid>:<toolName>) encodes everything — no preset
                onSpawnStart(entry.key, e.clientX, e.clientY);
            }}
        >
            <span
                className={`flex ${compact ? "h-9 w-9" : "h-12 w-12"} shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-foreground/15 ${CATEGORY_STYLES.mcp.headerBg}`}
            >
                {entry.logoDomain ? (
                    <McpLogo domain={entry.logoDomain} name={entry.label} size={"fill"} />
                ) : (
                    <EntryIcon entry={entry} />
                )}
            </span>
            <span
                className={`line-clamp-2 w-full break-words text-center ${compact ? "text-[9px]" : "text-[10px]"} leading-tight`}
            >
                {entry.label}
            </span>
        </div>
    );
}

function Chip({
    entry,
    enabled,
    borderL,
    onSpawnStart,
    preset,
}: {
    entry: CatalogEntry;
    enabled: boolean;
    borderL: string;
    onSpawnStart: SpawnStart;
    preset?: SpawnPreset;
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
                          onSpawnStart(entry.key, e.clientX, e.clientY, preset);
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
    userCatalog,
    openrouterModels,
    onSpawnStart,
    hasEvent,
}: {
    userCatalog: CatalogEntry[];
    // null = no credits and no OpenRouter key; [] = unlocked but fetch failed
    openrouterModels: OpenrouterModel[] | null;
    onSpawnStart: SpawnStart;
    // a workflow may hold only one event node — event chips disable once the
    // graph already has one
    hasEvent: boolean;
}) {
    const [group, setGroup] = useState("blocks");
    const active = GROUPS.find((g) => g.id === group) ?? GROUPS[0];

    // registered servers can carry dozens of tools each — filter by node
    // label or server name
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const matches = (entry: CatalogEntry) =>
        !q ||
        entry.label.toLowerCase().includes(q) ||
        (entry.group ?? "").toLowerCase().includes(q);

    // one grid cell per openrouter model, all spawning the single static
    // "model" node type with config prefilled; searchable by name and slug
    const models = (openrouterModels ?? []).filter(
        (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );

    return (
        <aside
            className={
                "flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-foreground/15 bg-background p-3 font-mono text-xs"
            }
        >
            {/* group tabs: faint circular Saturn-ringed backing per icon */}
            <div className={"flex justify-between gap-1"}>
                {GROUPS.map(({ id, label, Icon }) => {
                    const on = id === active.id;
                    return (
                        <button
                            key={id}
                            type={"button"}
                            title={label}
                            aria-label={label}
                            aria-pressed={on}
                            onClick={() => setGroup(id)}
                            className={
                                "flex flex-1 flex-col items-center gap-1 transition-opacity duration-200"
                            }
                        >
                            <span
                                className={`flex h-10 w-10 items-center justify-center rounded-full ring-1 transition-colors duration-200 ${
                                    on
                                        ? "bg-foreground/10 ring-foreground/40"
                                        : "bg-foreground/5 ring-foreground/10 hover:bg-foreground/10"
                                }`}
                            >
                                <Icon
                                    className={`h-4 w-4 transition-opacity duration-200 ${on ? "opacity-100" : "opacity-50"}`}
                                />
                            </span>
                            <span className={`text-[9px] ${on ? "text-foreground" : "text-gray-400"}`}>
                                {label}
                            </span>
                        </button>
                    );
                })}
            </div>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={"search nodes…"}
                aria-label={"search nodes"}
                className={
                    "border border-foreground/15 bg-background px-2 py-1.5 font-mono text-xs"
                }
            />
            {SECTIONS.filter((s) => active.categories.includes(s.category)).map(({ category, heading }) => {
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
                            {[...groups].map(([server, entries]) => {
                                // the "All tools" chip is the server's list-row
                                // (labelled with the server name); per-tool chips
                                // render below as a grid of rounded squares
                                const allTools = entries.filter((e) => e.toolName === "*");
                                const tools = entries.filter((e) => e.toolName !== "*");
                                return (
                                    <div key={server} className={"flex flex-col gap-1"}>
                                        {allTools.map((entry) => (
                                            <Chip
                                                key={entry.key}
                                                entry={{ ...entry, label: server }}
                                                enabled
                                                borderL={styles.borderL}
                                                onSpawnStart={onSpawnStart}
                                            />
                                        ))}
                                        {tools.length > 0 && (
                                            <div className={"grid grid-cols-4 gap-1"}>
                                                {tools.map((entry) => (
                                                    <McpToolChip
                                                        key={entry.key}
                                                        entry={entry}
                                                        onSpawnStart={onSpawnStart}
                                                        compact
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </section>
                    );
                }

                // models: the static blank chip (editable custom slug), then
                // a grid of circular cells, one per fetched openrouter model
                if (category === "model") {
                    const blank = CATALOG_BY_KEY.model;
                    return (
                        <section key={category} className={"flex flex-col gap-1.5"}>
                            <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                                {heading}
                            </h2>
                            {matches(blank) && (
                                <Chip
                                    entry={blank}
                                    enabled
                                    borderL={styles.borderL}
                                    onSpawnStart={onSpawnStart}
                                />
                            )}
                            {openrouterModels === null && (
                                <p className={"text-[10px] text-gray-400"}>
                                    upgrade or add an OpenRouter key in settings to list models
                                </p>
                            )}
                            {openrouterModels !== null && openrouterModels.length === 0 && (
                                <p className={"text-[10px] text-gray-400"}>
                                    couldn&apos;t load models
                                </p>
                            )}
                            {models.length === 0 && (openrouterModels?.length ?? 0) > 0 && q && (
                                <p className={"text-[10px] text-gray-400"}>no matches</p>
                            )}
                            <div className={"grid grid-cols-3 gap-1"}>
                                {models.map((m) => (
                                    <ModelChip key={m.id} model={m} onSpawnStart={onSpawnStart} />
                                ))}
                            </div>
                        </section>
                    );
                }

                const entries = [
                    ...CATALOG.filter((entry) => entry.category === category && !entry.legacy),
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
                                connect to an agent&apos;s skills port to grant
                            </p>
                        )}
                        {entries.length === 0 && (
                            <p className={"text-[10px] text-gray-400"}>
                                {q ? "no matches" : "none yet — add in settings"}
                            </p>
                        )}
                        {category === "events" && hasEvent && (
                            <p className={"text-[10px] text-gray-400"}>
                                one event per workflow — remove it to add another
                            </p>
                        )}
                        {entries.map((entry) => (
                            <Chip
                                key={entry.key}
                                entry={entry}
                                // only one event node allowed per graph
                                enabled={category !== "events" || !hasEvent}
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
