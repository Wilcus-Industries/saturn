"use client";

import { useCallback, useMemo, useState } from "react";
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
import type { GithubLink } from "./designer";
import EntryIcon from "./entryIcon";
import ModelLogo from "./modelLogo";
import type { VariableRow } from "./variableModal";

// github event chips (category "events", app group "github") stay non-spawnable
// until the owner links the central GitHub App installation
const isGithubEvent = (e: CatalogEntry) => e.category === "events" && e.group === "github";

// the 9 catalog categories collapse into 4 selectable toolbox groups, each a
// tab icon at the top; only the active group renders below. `blocks`/`agents`
// map to CATEGORY_HEADING sections; `apps`/`models` render specially.
const GROUPS: { id: string; label: string; Icon: IconType }[] = [
    { id: "blocks", label: "Blocks", Icon: FaCubes },
    { id: "apps", label: "Apps", Icon: FaPlug },
    { id: "agents", label: "Agents", Icon: FaRobot },
    { id: "models", label: "Models", Icon: FaBrain },
];

// section heading per catalog category for the standard (blocks/agents) render.
// saturn is headingless — its one "agent" chip under the "Agents" group tab
// makes a third "agents" heading pure redundancy.
const CATEGORY_HEADING: Partial<Record<NodeCategory, string>> = {
    events: "events",
    logic: "logic",
    data: "data",
    saturn: "",
    mcp: "tools",
    skill: "skills",
    memory: "memory",
    sandbox: "sandboxes",
};
const BLOCKS_CATEGORIES: NodeCategory[] = ["events", "logic", "data"];
const AGENTS_CATEGORIES: NodeCategory[] = ["saturn", "mcp", "skill", "memory", "sandbox"];

type CategorySection = { category: NodeCategory; heading: string; entries: CatalogEntry[] };

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
            // a chip only ever disables under the one-event rule — the hover
            // title explains the grey-out in place of a section hint line
            title={enabled ? undefined : "one event per workflow — remove the existing one first"}
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

// standard section render, shared by the blocks and agents groups: an optional
// heading, an empty/no-match line, and the chips (wiring guidance lives on the
// placed node's info popover, not here)
function Section({
    section,
    hasEvent,
    onSpawnStart,
    q,
}: {
    section: CategorySection;
    hasEvent: boolean;
    onSpawnStart: SpawnStart;
    q: string;
}) {
    const { category, heading, entries } = section;
    const styles = CATEGORY_STYLES[category];
    return (
        <section className={"flex flex-col gap-1.5"}>
            {heading && (
                <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>{heading}</h2>
            )}
            {entries.length === 0 && (
                <p className={"text-[10px] text-gray-400"}>
                    {q
                        ? "no matches"
                        : category === "sandbox"
                          ? "add sandboxes in the Sandboxes tab"
                          : "none yet — add in settings"}
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
}

export default function Toolbox({
    userCatalog,
    variables,
    openrouterModels,
    selfHosted,
    githubLink,
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
    // single-user mode — reword the empty-models hint (server key, not BYOK)
    selfHosted: boolean;
    // github event availability — "linked" enables the github chips; the other
    // states blank them out and show a hint under the github app heading
    githubLink: GithubLink;
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

    // registered servers can carry dozens of tools each — search matches a
    // node's label, key, app/group name, description, config-field labels, or a
    // server's tool names (find the server that has search_code). The match runs
    // across every group so a query hidden in another tab is still discoverable
    // via the count badges + switch hint below.
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const matches = useCallback(
        (entry: CatalogEntry) =>
            !q ||
            entry.label.toLowerCase().includes(q) ||
            entry.key.toLowerCase().includes(q) ||
            (entry.group ?? "").toLowerCase().includes(q) ||
            (entry.description ?? "").toLowerCase().includes(q) ||
            (entry.config ?? []).some((f) => f.label.toLowerCase().includes(q)) ||
            (entry.tools ?? []).some((t) => t.name.toLowerCase().includes(q)),
        [q],
    );

    // per-group visible-entry lists, built out of the JSX so match counts (for
    // the tab badges + cross-group switch hint) fall out of the same pass.
    const buildSections = useCallback(
        (categories: NodeCategory[]): CategorySection[] =>
            categories.map((category) => ({
                category,
                heading: CATEGORY_HEADING[category] ?? "",
                entries: [
                    // extension events carry an app `group` and live in the Apps
                    // tab, not here — keep the Blocks events section to ungrouped
                    // nodes (the schedule node)
                    ...CATALOG.filter(
                        (entry) => entry.category === category && !entry.legacy && !entry.group,
                    ),
                    // user registry entries follow the static ones
                    ...userCatalog.filter((entry) => entry.category === category),
                ].filter(matches),
            })),
        [userCatalog, matches],
    );
    const blocksSections = useMemo(() => buildSections(BLOCKS_CATEGORIES), [buildSections]);
    const agentsSections = useMemo(() => buildSections(AGENTS_CATEGORIES), [buildSections]);

    // apps: one headed section per app (entry.group), in CATALOG order; a
    // platform's outbound actions (integration) and inbound events (category
    // "events" carrying an app group) live together under the app header.
    const appsSections = useMemo(() => {
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
        return [...apps];
    }, [matches]);

    // models: the static blank chip (editable custom slug), then a grid of
    // circular cells, one per fetched openrouter model. The model list can run
    // to hundreds of entries, so this filter is memoized on [models, q] and the
    // count is a plain `.length` — never fed through per-group match loops.
    const blankModel = CATALOG_BY_KEY.model;
    const blankMatches = matches(blankModel);
    const models = useMemo(
        () =>
            (openrouterModels ?? []).filter(
                (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
            ),
        [openrouterModels, q],
    );

    // match count per group — only surfaced while a query is active
    const groupCounts: Record<string, number> = {
        blocks: blocksSections.reduce((n, s) => n + s.entries.length, 0),
        apps: appsSections.reduce((n, [, entries]) => n + entries.length, 0),
        agents: agentsSections.reduce((n, s) => n + s.entries.length, 0),
        models: models.length + (blankMatches ? 1 : 0),
    };
    // when the active group has no matches but another one does, point there
    const otherMatches =
        q && (groupCounts[active.id] ?? 0) === 0
            ? GROUPS.filter((g) => g.id !== active.id && (groupCounts[g.id] ?? 0) > 0)
            : [];

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
            {/* group tabs: faint circular Saturn-ringed backing per icon, with a
                match-count badge while a query is active */}
            <div className={"flex justify-between gap-1"}>
                {GROUPS.map(({ id, label, Icon }) => {
                    const on = id === active.id;
                    const count = groupCounts[id] ?? 0;
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
                                className={`relative flex h-10 w-10 items-center justify-center rounded-full ring-1 transition-colors duration-200 ${
                                    on
                                        ? "bg-foreground/10 ring-foreground/40"
                                        : "bg-foreground/5 ring-foreground/10 hover:bg-foreground/10"
                                }`}
                            >
                                <Icon
                                    className={`h-4 w-4 transition-opacity duration-200 ${on ? "opacity-100" : "opacity-50"}`}
                                />
                                {q && count > 0 && (
                                    <span
                                        className={
                                            "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[8px] leading-none text-background"
                                        }
                                    >
                                        {count}
                                    </span>
                                )}
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
            {/* cross-group hint: the active tab is empty but the query hits
                elsewhere — click to jump to that group */}
            {otherMatches.length > 0 && (
                <div className={"flex flex-col gap-1"}>
                    {otherMatches.map((g) => (
                        <button
                            key={g.id}
                            type={"button"}
                            onClick={() => setGroup(g.id)}
                            className={
                                "text-left text-[10px] text-gray-400 transition-colors duration-200 hover:text-foreground"
                            }
                        >
                            {groupCounts[g.id]} {groupCounts[g.id] === 1 ? "match" : "matches"} in{" "}
                            {g.label} →
                        </button>
                    ))}
                </div>
            )}

            {active.id === "blocks" &&
                blocksSections.map((section) => (
                    <Section
                        key={section.category}
                        section={section}
                        hasEvent={hasEvent}
                        onSpawnStart={onSpawnStart}
                        q={q}
                    />
                ))}

            {active.id === "agents" &&
                agentsSections.map((section) => (
                    <Section
                        key={section.category}
                        section={section}
                        hasEvent={hasEvent}
                        onSpawnStart={onSpawnStart}
                        q={q}
                    />
                ))}

            {active.id === "apps" && (
                <>
                    {appsSections.length === 0 && (
                        <p className={"text-[10px] text-gray-400"}>{q ? "no matches" : "none yet"}</p>
                    )}
                    {appsSections.map(([app, entries]) => (
                        <section key={app} className={"flex flex-col gap-1.5"}>
                            <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                                {app}
                            </h2>
                            {app === "github" && githubLink !== "linked" && (
                                <p className={"text-[10px] text-gray-400"}>
                                    {githubLink === "unlinked"
                                        ? "github events need the GitHub App — link it in settings"
                                        : "github events need a GitHub App on this server — see deploy/README.md"}
                                </p>
                            )}
                            {entries.map((entry) => (
                                <Chip
                                    key={entry.key}
                                    entry={entry}
                                    // event chips obey the one-event rule; github
                                    // events also need a linked installation;
                                    // action chips are always spawnable
                                    enabled={
                                        (entry.category !== "events" || !hasEvent) &&
                                        (githubLink === "linked" || !isGithubEvent(entry))
                                    }
                                    // section color, not the integration category's
                                    // — mirrors Blocks (events chips paint amber)
                                    borderL={entryStyles(entry).borderL}
                                    onSpawnStart={onSpawnStart}
                                />
                            ))}
                        </section>
                    ))}
                </>
            )}

            {active.id === "models" && (
                <section className={"flex flex-col gap-1.5"}>
                    <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>models</h2>
                    {blankMatches && (
                        <Chip
                            entry={blankModel}
                            enabled
                            borderL={CATEGORY_STYLES.model.borderL}
                            onSpawnStart={onSpawnStart}
                        />
                    )}
                    {openrouterModels === null && (
                        <p className={"text-[10px] text-gray-400"}>
                            {selfHosted
                                ? "set PLATFORM_OPENROUTER_KEY on the server to list models"
                                : "upgrade or add an OpenRouter key in settings to list models"}
                        </p>
                    )}
                    {openrouterModels !== null && openrouterModels.length === 0 && (
                        <p className={"text-[10px] text-gray-400"}>couldn&apos;t load models</p>
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
            )}
            </div>

            {/* variables split: pinned below the tabbed sections, outside the
                group filter — secrets and regular variables managed here
                (VariableModal), each row drag-spawning its variable:<uuid> box */}
            <div
                className={
                    "flex max-h-[45%] shrink-0 flex-col gap-1.5 overflow-y-auto border-t border-foreground/15 p-3"
                }
            >
                <div className={"flex items-center justify-between"}>
                    <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>
                        variables
                    </h2>
                    {/* +add stays visible even when the query filters every row
                        out, so a variable is always addable */}
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
                {varQ.length === 0 && (
                    <p className={"text-[10px] text-gray-400"}>
                        {q && variables.length > 0
                            ? `no variables match "${q}"`
                            : "none yet — secrets and reusable values live here"}
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
                                    borderL={entryStyles(entry).borderL}
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
