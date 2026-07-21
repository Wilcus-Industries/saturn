"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import type { ConfigField } from "@/lib/workflow";

// Shared renderer for a single config-field control (select / textarea / text /
// number). Deduplicates the two copies that used to live in node.tsx — the
// agent branch's dropdown row and the generic rect branch's config rows. It
// renders ONLY the bare control element: the wrapping <label> (name strip, the
// paired inline port, the json-path picker button) differs per branch and stays
// in node.tsx. Lives in its own file per the react-hooks/refs false-positive
// note in nodeFrame.tsx — never nest a second component inside node.tsx.
//
// dynamicOptions selects (the agent's output/reasoning) resolve their option
// list from `dynStr` (the canvas-computed comma string for THIS field, "" when
// the resolved model's capability is unknown) and lock — disabled + a hint
// title + dimmed — when the resolved list is empty, exactly as both old copies
// did. A caller-supplied `disabled` (a connected overriding port) dims and locks
// the control the same way, its reason carried by `disabledTitle`.
export default function ConfigControl({
    field,
    value,
    disabled,
    disabledTitle,
    dynStr,
    fontClass,
    onChange,
    onFocus,
    onBlur,
}: {
    field: ConfigField;
    value: string;
    // an overriding connected port (or other caller reason) — dims + locks
    disabled: boolean;
    disabledTitle?: string;
    // dynamicOptions comma string for this field ("" = unknown/not dynamic)
    dynStr: string;
    // the control's font size — "text-xs" (generic rows) or "text-[10px]"
    // (agent dropdown row); the only visual difference between the two callers
    fontClass: string;
    onChange: (value: string) => void;
    onFocus: () => void;
    onBlur: () => void;
}) {
    // stopPropagation keeps a press on the control from starting a node drag
    const stop = (e: ReactPointerEvent) => e.stopPropagation();
    const base = `w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 font-mono ${fontClass}`;

    if (field.input === "select") {
        const options = field.dynamicOptions
            ? dynStr
                ? dynStr.split(",")
                : []
            : (field.options ?? []);
        // a dynamicOptions field with no resolved options is locked: the model
        // is unknown / non-capable, so there's nothing to pick
        const locked = !!field.dynamicOptions && options.length === 0;
        const off = disabled || locked;
        const title = locked
            ? field.id === "reasoning"
                ? "model has no reasoning setting — pick a reasoning-capable model"
                : "output modalities unknown — set a model from the OpenRouter list"
            : disabledTitle;
        return (
            <select
                value={value}
                disabled={off}
                title={title}
                onPointerDown={stop}
                onFocus={onFocus}
                onBlur={onBlur}
                onChange={(e) => onChange(e.target.value)}
                className={`${base} ${off ? "opacity-40" : ""}`}
            >
                <option value={""} hidden />
                {options.map((opt) => (
                    <option key={opt} value={opt}>
                        {opt}
                    </option>
                ))}
            </select>
        );
    }

    if (field.input === "textarea") {
        return (
            <textarea
                value={value}
                disabled={disabled}
                title={disabledTitle}
                rows={3}
                maxLength={4000}
                placeholder={field.placeholder}
                onPointerDown={stop}
                onFocus={onFocus}
                onBlur={onBlur}
                onChange={(e) => onChange(e.target.value)}
                className={`${base} h-[60px] resize-none ${disabled ? "opacity-40" : ""}`}
            />
        );
    }

    return (
        <input
            type={field.input}
            value={value}
            disabled={disabled}
            title={disabledTitle}
            placeholder={field.placeholder}
            onPointerDown={stop}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onChange(e.target.value)}
            className={`${base} ${disabled ? "opacity-40" : ""}`}
        />
    );
}
