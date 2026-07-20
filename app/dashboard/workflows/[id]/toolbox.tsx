"use client";

import { Fragment, useState } from "react";
import type { IconType } from "react-icons";
import { FaBrain, FaCubes, FaPlug, FaRobot } from "react-icons/fa6";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/lib/openrouter.server";
import {
    CATALOG,
    CATALOG_BY_KEY,
    CATEGORY_STYLES,
    type CatalogEntry,
    entryStyles,
    MODEL_PRESET,
    type NodeCategory,
} from "@/lib/workflow";
import EntryIcon from "./entryIcon";
import ModelLogo from "./modelLogo";
import type { VariableRow } from "./variableModal";

const SECTIONS: { category: NodeCategory; heading: string }[] = [
    { category: "events", heading: "events" },
    { category: "logic", heading: "logic" },
    { category: "data", heading: "data" },
    { category: "saturn", heading: "agents" },
    // integration renders one heading per app, so this heading is unused —
    // the branch below replaces it
    { category: "integration", heading: "integrations" },
    { category: "mcp", heading: "tools" },
    { category: "skill", heading: "skills" },
    { category: "memory", heading: "memory" },
    { category: "model", heading: "models" },
];

// the 9 catalog categories collapse into 4 selectable toolbox groups, each a
// tab icon at the top; only the active group's SECTIONS render below
const GROUPS: { id: string; label: string; Icon: IconType; categories: NodeCategory[] }[] = [
    { id: "blocks", label: "Blocks", Icon: FaCubes, categories: ["events", "logic", "data"] },
    { id: "integrations", label: "Apps", Icon: FaPlug, categories: ["integration"] },
    { id: "agents", label: "Agents", Icon: FaRobot, categories: ["saturn", "mcp", "skill", "memory"] },
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
                    config: { model: model.id, preset: MODEL_PRESET },
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
    variables,
    openrouterModels,
    onSpawnStart,
    onEditVariable,
    hasEvent,
}: {
    userCatalog: CatalogEntry[];
    // secret variables (kind 'variable' registry rows) — listed in the pinned
    // bottom split, managed via VariableModal; hasValue mirrors has_token
    variables: VariableRow[];
    // null = no credits and no OpenRouter key; [] = unlocked but fetch failed
    openrouterModels: OpenrouterModel[] | null;
    onSpawnStart: SpawnStart;
    // open the secret-variable modal — "new" (the +add row) or an existing row
    // to edit. The modal itself is hosted by the designer (a variable node on
    // the canvas opens it too), so the toolbox only signals intent.
    onEditVariable: (target: VariableRow | "new") => void;
    // a workflow may hold only one event node — event chips disable once the
    // graph already has one
    hasEvent: boolean;
}) {
    const [group, setGroup] = useState("blocks");
    const active = GROUPS.find((g) => g.id === group) ?? GROUPS[0];

    // registered servers can carry dozens of tools each — filter by node
    // label, app name, or a server's tool names (find the server that has
    // search_code)
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const matches = (entry: CatalogEntry) =>
        !q ||
        entry.label.toLowerCase().includes(q) ||
        (entry.group ?? "").toLowerCase().includes(q) ||
        (entry.tools ?? []).some((t) => t.name.toLowerCase().includes(q));

    // one grid cell per openrouter model, all spawning the single static
    // "model" node type with config prefilled; searchable by name and slug
    const models = (openrouterModels ?? []).filter(
        (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );

    const varQ = variables.filter((v) => !q || v.name.toLowerCase().includes(q));
    const variableByKey = new Map(
        userCatalog.filter((e) => e.category === "variable").map((e) => [e.key, e]),
    );

    return (
        <aside
            className={
                "flex w-56 shrink-0 flex-col border-r border-foreground/15 bg-background font-mono text-xs"
            }
        >
            {/* tabbed sections scroll on their own; the variables split below
                stays pinned to the toolbox bottom across every group tab */}
            <div className={"flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3"}>
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

                // integration: one headed section per app (entry.group), in
                // CATALOG order; a platform's outbound actions (integration) and
                // inbound events (category "events" carrying an app group) live
                // together under the app header. Action chips paint in their
                // Blocks section's color (mirrors the Blocks group); event chips
                // paint amber (their events category, no section) and obey the
                // one-event-per-workflow rule.
                if (category === "integration") {
                    const apps = new Map<string, CatalogEntry[]>();
                    for (const entry of CATALOG) {
                        const isApp =
                            entry.category === "integration" ||
                            (entry.category === "events" && entry.group !== undefined);
                        if (!isApp || entry.legacy || !matches(entry)) continue;
                        const app = entry.group ?? entry.label;
                        const list = apps.get(app);
                        if (list) list.push(entry);
                        else apps.set(app, [entry]);
                    }
                    return (
                        <Fragment key={category}>
                            {apps.size === 0 && (
                                <p className={"text-[10px] text-gray-400"}>
                                    {q ? "no matches" : "none yet"}
                                </p>
                            )}
                            {[...apps].map(([app, entries]) => (
                                <section key={app} className={"flex flex-col gap-1.5"}>
                                    <h2
                                        className={
                                            "text-[10px] uppercase tracking-wider text-gray-400"
                                        }
                                    >
                                        {app}
                                    </h2>
                                    {entries.map((entry) => (
                                        <Chip
                                            key={entry.key}
                                            entry={entry}
                                            // event chips obey the one-event rule;
                                            // action chips are always spawnable
                                            enabled={entry.category !== "events" || !hasEvent}
                                            // section color, not the integration
                                            // category's — mirrors Blocks
                                            borderL={entryStyles(entry).borderL}
                                            onSpawnStart={onSpawnStart}
                                        />
                                    ))}
                                </section>
                            ))}
                        </Fragment>
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
                    // extension events carry an app `group` and live in the Apps
                    // tab, not here — keep the Blocks events section to ungrouped
                    // nodes (the schedule node)
                    ...CATALOG.filter(
                        (entry) => entry.category === category && !entry.legacy && !entry.group,
                    ),
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
                        {category === "mcp" && entries.length > 0 && (
                            <p className={"text-[10px] text-gray-400"}>
                                connect to an agent&apos;s tools port to grant — click the
                                placed node to pick tools
                            </p>
                        )}
                        {category === "memory" && entries.length > 0 && (
                            <p className={"text-[10px] text-gray-400"}>
                                connect to an agent&apos;s memory port — one store per agent
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
            </div>

            {/* variables split: pinned below the tabbed sections, outside the
                group filter — secret values managed here (VariableModal), each
                row drag-spawning its read-only variable:<uuid> value box */}
            <div
                className={
                    "flex max-h-[45%] shrink-0 flex-col gap-1.5 overflow-y-auto border-t border-foreground/15 p-3"
                }
            >
                <div className={"flex items-center justify-between"}>
                    <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                        variables
                    </h2>
                    <button
                        type={"button"}
                        onClick={() => onEditVariable("new")}
                        className={
                            "text-[10px] text-gray-400 transition-colors duration-200 hover:text-foreground"
                        }
                    >
                        + add
                    </button>
                </div>
                {variables.length > 0 && (
                    <p className={"text-[10px] text-gray-400"}>
                        secret values — resolved only inside app action nodes
                    </p>
                )}
                {varQ.length === 0 && (
                    <p className={"text-[10px] text-gray-400"}>
                        {q && variables.length > 0 ? "no matches" : "none yet — secrets like bot tokens live here"}
                    </p>
                )}
                {varQ.map((v) => {
                    const entry = variableByKey.get(`variable:${v.id}`);
                    if (!entry) return null;
                    return (
                        <div key={v.id} className={"flex items-center gap-1"}>
                            <div className={"min-w-0 flex-1"}>
                                <Chip
                                    entry={entry}
                                    enabled
                                    borderL={CATEGORY_STYLES.variable.borderL}
                                    onSpawnStart={onSpawnStart}
                                />
                            </div>
                            <button
                                type={"button"}
                                title={"edit variable"}
                                aria-label={`edit variable ${v.name}`}
                                onClick={() => onEditVariable(v)}
                                className={
                                    "shrink-0 px-1 text-gray-400 transition-colors duration-200 hover:text-foreground"
                                }
                            >
                                ✎
                            </button>
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}
