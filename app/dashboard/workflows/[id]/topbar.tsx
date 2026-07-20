"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import DeleteWorkflowButton from "@/app/dashboard/deleteWorkflowButton";
import type { ValidationIssue } from "@/lib/workflow";
import PopoverShell from "./popoverShell";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function Topbar({
    workflowId,
    emoji,
    name,
    dirty,
    saving,
    error,
    issues,
    onSelectIssue,
    events,
    selectedEventId,
    onSelectEvent,
    onRun,
    onStop,
    running,
}: {
    workflowId: string;
    emoji: string;
    name: string;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    // live validation findings (already suppressed on an empty graph by the
    // designer); the badge summarizes them, the panel lists them
    issues: ValidationIssue[];
    // select the node an issue concerns (issues with a nodeId only)
    onSelectIssue: (nodeId: string) => void;
    // event nodes in the graph — the test runner fires the selected one
    events: { id: string; label: string }[];
    selectedEventId: string;
    onSelectEvent: (id: string) => void;
    onRun: () => void;
    onStop: () => void;
    running: boolean;
}) {
    const [frame, setFrame] = useState(0);
    // the issues panel's anchor (null = closed); set to the badge's bottom-left
    // corner on click so PopoverShell measures-and-clamps from there
    const [panelAnchor, setPanelAnchor] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!saving) return;
        const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
        return () => clearInterval(id);
    }, [saving]);

    const errorCount = issues.reduce((n, i) => n + (i.level === "error" ? 1 : 0), 0);
    const warningCount = issues.length - errorCount;

    // if every issue clears while the panel is open, close it during render —
    // the badge that anchored it is gone, so a stale anchor must not linger or
    // reopen on the next issue. Adjust-state-during-render, not an effect (it
    // converges: the next pass sees panelAnchor null and the branch is dead).
    if (panelAnchor && issues.length === 0) setPanelAnchor(null);

    return (
        <header
            className={
                "flex h-12 shrink-0 items-center gap-3 border-b border-foreground/15 px-3 font-mono text-sm"
            }
        >
            <Link
                href={"/dashboard/workflows"}
                className={
                    "rounded-full px-3 py-1 text-gray-400 transition-colors duration-200 hover:bg-foreground hover:text-background"
                }
            >
                ← workflows
            </Link>

            <span className={"truncate"}>
                {emoji} {name}
            </span>

            {/* run history lives on a shell page, not in the designer */}
            <Link
                href={`/dashboard/workflows/${workflowId}/runs`}
                className={`hidden shrink-0 rounded-full border border-foreground/15 px-3 py-0.5
                    text-xs text-gray-400 transition-colors duration-200
                    hover:border-foreground/40 hover:text-foreground sm:inline`}
            >
                runs
            </Link>

            <span className={"ml-auto flex items-center gap-2"}>
                {/* test event runner — pick which event node to fire, then run
                    it through the client-side interpreter (see interpreter.ts).
                    The run button turns into a stop button while running (an
                    in-flight MCP call finishes, then the run halts). */}
                <select
                    value={selectedEventId}
                    onChange={(e) => onSelectEvent(e.target.value)}
                    disabled={running || events.length === 0}
                    aria-label={"event to test"}
                    className={
                        "max-w-40 shrink-0 truncate border border-foreground/15 bg-background px-2 py-0.5 text-xs text-gray-400 disabled:opacity-50"
                    }
                >
                    {events.length === 0 ? (
                        <option value={""}>no events</option>
                    ) : (
                        events.map((ev) => (
                            <option key={ev.id} value={ev.id}>
                                {ev.label}
                            </option>
                        ))
                    )}
                </select>
                {running ? (
                    <button
                        type={"button"}
                        onClick={onStop}
                        className={`border border-red-500 px-2 py-0.5 text-red-600 transition-colors
                            duration-200 hover:bg-red-600 hover:text-white dark:text-red-400`}
                    >
                        ■ stop
                    </button>
                ) : (
                    <button
                        type={"button"}
                        onClick={onRun}
                        disabled={events.length === 0}
                        title={events.length === 0 ? "add an event node to run" : "test this event"}
                        className={`border border-green-500 px-2 py-0.5 text-green-600 transition-colors
                            duration-200 hover:bg-green-600 hover:text-white disabled:cursor-not-allowed
                            disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-green-600
                            dark:text-green-400`}
                    >
                        ▶ run
                    </button>
                )}
                <DeleteWorkflowButton id={workflowId} />
            </span>

            {/* validation summary badge — red errors win, else amber warnings,
                nothing when the graph is clean or empty. Opens the issues panel. */}
            {issues.length > 0 && (
                <button
                    type={"button"}
                    onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setPanelAnchor((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }));
                    }}
                    title={"validation issues"}
                    className={`shrink-0 border px-2 py-0.5 text-xs transition-colors duration-200 ${
                        errorCount > 0
                            ? "border-red-500/60 text-red-600 hover:bg-red-500/10 dark:text-red-400"
                            : "border-amber-500/60 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
                    }`}
                >
                    {errorCount > 0 ? `✕ ${errorCount}` : `⚠ ${warningCount}`}
                </button>
            )}

            {/* autosave status — one slot, always rendered, so the layout doesn't shift */}
            <span className={"text-xs"} aria-live={"polite"} aria-busy={saving}>
                {saving ? (
                    <span className={"text-gray-400"}>{FRAMES[frame]}</span>
                ) : error ? (
                    <span className={"text-red-500"}>save failed — retrying</span>
                ) : dirty ? (
                    <span className={"text-gray-400"} title={"unsaved changes"}>
                        ●
                    </span>
                ) : (
                    <span className={"text-gray-400"}>saved</span>
                )}
            </span>

            {panelAnchor && issues.length > 0 && (
                <PopoverShell
                    anchor={panelAnchor}
                    onClose={() => setPanelAnchor(null)}
                    className={
                        "flex max-h-80 w-96 max-w-[calc(100vw-16px)] flex-col overflow-y-auto border border-foreground/15 bg-background py-1 font-mono text-xs shadow-lg"
                    }
                >
                    {issues.map((issue, i) => {
                        const clickable = !!issue.nodeId;
                        return (
                            <button
                                key={i}
                                type={"button"}
                                disabled={!clickable}
                                onClick={() => {
                                    if (!issue.nodeId) return;
                                    onSelectIssue(issue.nodeId);
                                    setPanelAnchor(null);
                                }}
                                className={`flex items-start gap-2 px-3 py-1.5 text-left ${
                                    clickable
                                        ? "cursor-pointer hover:bg-foreground/5"
                                        : "cursor-default"
                                }`}
                            >
                                <span
                                    aria-hidden
                                    className={`mt-px shrink-0 ${
                                        issue.level === "error"
                                            ? "text-red-600 dark:text-red-400"
                                            : "text-amber-600 dark:text-amber-400"
                                    }`}
                                >
                                    {issue.level === "error" ? "✕" : "⚠"}
                                </span>
                                <span className={"min-w-0 flex-1 break-words text-gray-500 dark:text-gray-400"}>
                                    {issue.message}
                                </span>
                            </button>
                        );
                    })}
                </PopoverShell>
            )}
        </header>
    );
}
