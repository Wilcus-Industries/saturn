"use client";

import { useState } from "react";
import McpLogo from "@/app/dashboard/mcpLogo";
import type { CatalogEntry } from "@/lib/workflow";

const PANEL_W = 320; // w-80
const PANEL_MAX_H = 320; // max-h-80

// checkbox popover for an agent node's per-node grants, anchored under
// the config row button. kind="tools" lists the registry's enabled MCP tools
// (the non-legacy userCatalog mcp entries exist only for enabled tools),
// grouped by server; kind="skills" lists registry skills. Selections apply
// as one undo step via onApply; the backdrop closes without applying.
export default function GrantPicker({
    anchor,
    kind,
    userCatalog,
    selected,
    onApply,
    onClose,
}: {
    anchor: { x: number; y: number };
    kind: "tools" | "skills";
    userCatalog: CatalogEntry[];
    selected: string[];
    onApply: (ids: string[]) => void;
    onClose: () => void;
}) {
    // clamp once at mount — the backdrop prevents the anchor from going stale
    const [position] = useState(() => ({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - PANEL_W - 8)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - PANEL_MAX_H - 8)),
    }));
    const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));

    const toggle = (id: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // grant ids match lib/agent.ts parsers: tools "<entryId>:<toolName>"
    // (fixed-offset uuid slice of the "mcp:<uuid>:<tool>" node key — tool
    // names may contain ":"), skills the bare uuid
    const rows: { id: string; label: string; group?: string; entry: CatalogEntry }[] =
        kind === "tools"
            ? userCatalog
                  .filter((e) => e.category === "mcp" && !e.legacy && e.toolName)
                  .map((e) => ({
                      id: `${e.key.slice(4, 40)}:${e.toolName}`,
                      label: e.toolName ?? e.label,
                      group: e.group ?? e.label,
                      entry: e,
                  }))
            : userCatalog
                  .filter((e) => e.category === "skill")
                  .map((e) => ({
                      id: e.key.slice(6),
                      label: e.label,
                      entry: e,
                  }));

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
        const group = row.group ?? "";
        const list = groups.get(group);
        if (list) list.push(row);
        else groups.set(group, [row]);
    }

    const checkbox = (row: (typeof rows)[number]) => (
        <label
            key={row.id}
            className={
                "flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-foreground/5"
            }
        >
            <input
                type={"checkbox"}
                checked={checked.has(row.id)}
                onChange={() => toggle(row.id)}
                className={"accent-cyan-500"}
            />
            {kind === "skills" && row.entry.emoji && (
                <span className={"text-sm"}>{row.entry.emoji}</span>
            )}
            <span className={"truncate"}>{row.label}</span>
        </label>
    );

    return (
        <>
            <div className={"fixed inset-0 z-40"} onPointerDown={onClose} />
            <div
                style={position}
                className={
                    "fixed z-50 flex max-h-80 w-80 flex-col border border-foreground/15 bg-background font-mono text-xs shadow-lg"
                }
            >
                <div className={"flex-1 overflow-auto p-1"}>
                    {rows.length === 0 && (
                        <p className={"p-2 text-gray-400"}>none yet — add in settings</p>
                    )}
                    {kind === "tools"
                        ? [...groups].map(([server, list]) => (
                              <div key={server} className={"mb-1"}>
                                  <div
                                      className={
                                          "flex items-center gap-1.5 px-1 py-0.5 text-[10px] text-gray-400"
                                      }
                                  >
                                      {list[0].entry.logoDomain && (
                                          <McpLogo
                                              domain={list[0].entry.logoDomain}
                                              name={server}
                                              size={16}
                                          />
                                      )}
                                      <span className={"truncate"}>{server}</span>
                                  </div>
                                  <div className={"pl-3"}>{list.map(checkbox)}</div>
                              </div>
                          ))
                        : rows.map(checkbox)}
                </div>
                {rows.length > 0 && (
                    <div
                        className={
                            "flex items-center justify-between border-t border-foreground/15 p-1.5"
                        }
                    >
                        <span className={"text-gray-400"}>{checked.size} selected</span>
                        <button
                            type={"button"}
                            onClick={() => onApply([...checked].sort())}
                            className={
                                "border border-foreground/15 px-2 py-0.5 hover:bg-foreground/5"
                            }
                        >
                            apply
                        </button>
                    </div>
                )}
            </div>
        </>
    );
}
