"use client";

import { useState } from "react";
import { MAX_MCP_TOOLS, type McpTool } from "@/lib/registry";

// each tool gets a 3-position access switch mapping onto {enabled, access}:
// off = disabled, read = enabled read-only, read+write = enabled write.
// Positions the tool's *declared* capability contradicts are disabled —
// "read" when the server explicitly marks the tool write-capable (canCallTool
// in lib/registry.ts blocks those calls), "read+write" on a declared-read-only
// tool (grants nothing). Undeclared capability leaves every position open:
// the grant is the user's own classification there.
const SEGMENTS: {
    label: string;
    patch: Partial<McpTool>;
    isActive: (t: McpTool) => boolean;
    isDisabled: (t: McpTool) => boolean;
    disabledTitle: string;
    activeClass: string;
}[] = [
    {
        label: "off",
        patch: { enabled: false },
        isActive: (t) => !t.enabled,
        isDisabled: () => false,
        disabledTitle: "",
        activeClass: "bg-foreground/15 text-foreground",
    },
    {
        label: "read",
        patch: { enabled: true, access: "read" },
        isActive: (t) => t.enabled && t.access === "read",
        isDisabled: (t) => t.readOnly === false,
        disabledTitle:
            "server declares this tool write-capable — a read-only grant can't be enforced",
        activeClass: "bg-blue-500/20 text-blue-400",
    },
    {
        label: "read+write",
        patch: { enabled: true, access: "write" },
        isActive: (t) => t.enabled && t.access === "write",
        isDisabled: (t) => t.readOnly === true,
        disabledTitle: "server declares this tool read-only — read is all it can do",
        activeClass: "bg-yellow-500/20 text-yellow-500",
    },
];

// per-tool allowlist rows for an MCP server; serialized into a hidden
// "tools" field so the surrounding server-action form can submit it
export default function ToolListEditor({ initial }: { initial: McpTool[] }) {
    const [tools, setTools] = useState<McpTool[]>(initial);

    const update = (index: number, patch: Partial<McpTool>) =>
        setTools(tools.map((t, i) => (i === index ? { ...t, ...patch } : t)));

    return (
        <div className={"flex flex-col gap-2"}>
            <span className={"font-mono text-xs text-gray-400"}>tools</span>

            {tools.length === 0 && (
                <p className={"font-mono text-xs text-gray-400"}>
                    no tools allowed yet — add the tools this server may expose
                </p>
            )}

            {tools.map((tool, i) => (
                <div key={i} className={"flex items-center gap-2"}>
                    <div className={"flex min-w-0 flex-1 flex-col gap-0.5"}>
                        <input
                            value={tool.name}
                            onChange={(e) => update(i, { name: e.target.value })}
                            placeholder={"tool name"}
                            aria-label={`tool ${i + 1} name`}
                            className={`min-w-0 border border-foreground/15 bg-background p-2
                                font-mono text-sm`}
                        />
                        {tool.description && (
                            <span
                                title={tool.description}
                                className={"line-clamp-2 font-mono text-[11px] text-gray-500"}
                            >
                                {tool.description}
                            </span>
                        )}
                    </div>
                    <div
                        role={"radiogroup"}
                        aria-label={`tool ${i + 1} access`}
                        className={"flex shrink-0 border border-foreground/15"}
                    >
                        {SEGMENTS.map((segment) => {
                            const active = segment.isActive(tool);
                            // an active-but-disabled segment stays visible so a
                            // stale stored grant is apparent, just not clickable
                            const disabled = segment.isDisabled(tool);
                            return (
                                <button
                                    key={segment.label}
                                    type={"button"}
                                    role={"radio"}
                                    aria-checked={active}
                                    disabled={disabled}
                                    title={disabled ? segment.disabledTitle : undefined}
                                    onClick={() => update(i, segment.patch)}
                                    className={`px-2 py-2 font-mono text-xs transition-colors
                                        duration-200 ${active
                                            ? segment.activeClass
                                            : disabled
                                              ? "cursor-not-allowed text-gray-600"
                                              : "text-gray-400 hover:text-foreground"}`}
                                >
                                    {segment.label}
                                </button>
                            );
                        })}
                    </div>
                    <button
                        type={"button"}
                        onClick={() => setTools(tools.filter((_, j) => j !== i))}
                        aria-label={`remove tool ${i + 1}`}
                        className={"px-1 font-mono text-sm text-gray-400 hover:text-red-500"}
                    >
                        ✕
                    </button>
                </div>
            ))}

            {tools.length < MAX_MCP_TOOLS && (
                <button
                    type={"button"}
                    onClick={() =>
                        setTools([...tools, { name: "", access: "read", enabled: true }])
                    }
                    className={`self-start border border-dashed border-foreground/30 px-2 py-1
                        font-mono text-xs text-gray-400 transition-colors duration-200
                        hover:border-foreground hover:text-foreground`}
                >
                    + add tool
                </button>
            )}

            {/* strict triple only — discovered description/params stay server-side
                (saveMcpServer re-attaches them by name) and off the wire */}
            <input
                type={"hidden"}
                name={"tools"}
                value={JSON.stringify(
                    tools.map(({ name, access, enabled }) => ({ name, access, enabled })),
                )}
            />
        </div>
    );
}
