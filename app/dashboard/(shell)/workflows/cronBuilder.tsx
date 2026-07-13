"use client";

import { useEffect, useState } from "react";
import { describeCron } from "@/lib/cron";

type Frequency = "minutes" | "hourly" | "daily" | "weekly" | "monthly";

const FREQUENCIES: Frequency[] = ["minutes", "hourly", "daily", "weekly", "monthly"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// "minutes" intervals the builder offers; 1 emits "* * * * *", n emits "*/n * * * *"
const EVERY_OPTIONS = [1, 5, 10, 15, 30];
// the shortest interval (minutes) each frequency can fire, for the tier floor cap
const FREQUENCY_MIN: Record<Frequency, number> = {
    minutes: 1,
    hourly: 60,
    daily: 60 * 24,
    weekly: 60 * 24 * 7,
    monthly: 60 * 24 * 28,
};

const range = (length: number, start = 0) => Array.from({ length }, (_, i) => i + start);
const pad2 = (n: number) => String(n).padStart(2, "0");

type BuilderState = {
    frequency: Frequency;
    every: number;
    minute: number;
    hour: number;
    dayOfWeek: number;
    dayOfMonth: number;
};

const DEFAULT_STATE: BuilderState = {
    frequency: "daily",
    every: 5,
    minute: 0,
    hour: 9,
    dayOfWeek: 1,
    dayOfMonth: 1,
};

// map a stored cron back onto the builder's controls (edit modal); an
// expression outside the 5 emitted shapes falls back to the defaults
function parseCron(cron: string | undefined): BuilderState {
    if (!cron) return DEFAULT_STATE;
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5 || fields[3] !== "*") return DEFAULT_STATE;

    // * * * * *  /  */n * * * *  → the "minutes" frequency
    if (fields[1] === "*" && fields[2] === "*" && fields[4] === "*") {
        if (fields[0] === "*") return { ...DEFAULT_STATE, frequency: "minutes", every: 1 };
        if (fields[0].startsWith("*/")) {
            const n = Number(fields[0].slice(2));
            return EVERY_OPTIONS.includes(n)
                ? { ...DEFAULT_STATE, frequency: "minutes", every: n }
                : DEFAULT_STATE;
        }
    }

    const [m, h, dom, , dow] = fields.map((f) => (f === "*" ? null : Number(f)));
    if (m === null || Number.isNaN(m)) return DEFAULT_STATE;
    const base = { ...DEFAULT_STATE, minute: m };
    if (h === null) return dom === null && dow === null ? { ...base, frequency: "hourly" } : DEFAULT_STATE;
    if (Number.isNaN(h)) return DEFAULT_STATE;
    if (dom === null && dow === null) return { ...base, hour: h, frequency: "daily" };
    if (dom === null && dow !== null && !Number.isNaN(dow)) {
        return { ...base, hour: h, frequency: "weekly", dayOfWeek: dow };
    }
    if (dow === null && dom !== null && !Number.isNaN(dom) && dom <= 28) {
        return { ...base, hour: h, frequency: "monthly", dayOfMonth: dom };
    }
    return DEFAULT_STATE;
}

// visual builder for the cron shapes describeCron understands. In the designer
// it runs in callback mode (onChange writes the node config); floorMinutes caps
// the offered intervals to the user's tier cron floor. The form-field path
// (hidden input) is kept for any <form> consumer.
export default function CronBuilder({
    initial,
    onChange,
    floorMinutes,
    name = "cron",
}: {
    initial?: string;
    onChange?: (cron: string) => void;
    floorMinutes?: number;
    name?: string;
}) {
    const [start] = useState(() => parseCron(initial));
    const [frequency, setFrequency] = useState<Frequency>(start.frequency);
    const [every, setEvery] = useState(start.every);
    const [minute, setMinute] = useState(start.minute);
    const [hour, setHour] = useState(start.hour);
    const [dayOfWeek, setDayOfWeek] = useState(start.dayOfWeek);
    const [dayOfMonth, setDayOfMonth] = useState(start.dayOfMonth);

    const cron =
        frequency === "minutes" ? (every === 1 ? "* * * * *" : `*/${every} * * * *`)
        : frequency === "hourly" ? `${minute} * * * *`
        : frequency === "daily" ? `${minute} ${hour} * * *`
        : frequency === "weekly" ? `${minute} ${hour} * * ${dayOfWeek}`
        : `${minute} ${hour} ${dayOfMonth} * *`;

    // report the current expression to a callback consumer on every change
    useEffect(() => {
        onChange?.(cron);
    }, [cron, onChange]);

    // tier floor cap: hide frequencies/intervals below the floor, but always
    // keep the CURRENT selection visible (a downgraded user may hold a tighter
    // grandfathered cron — the runner clamps it, the picker just can't tighten).
    // The current `every` is preserved only when "minutes" is actually selected,
    // so a default every=5 on a daily node can't reopen sub-floor intervals.
    const floor = floorMinutes ?? 1;
    const everyOptions = EVERY_OPTIONS.filter(
        (n) => n >= floor || (frequency === "minutes" && n === every),
    );
    const frequencies = FREQUENCIES.filter(
        (f) =>
            f === frequency ||
            (f === "minutes" ? EVERY_OPTIONS.some((n) => n >= floor) : FREQUENCY_MIN[f] >= floor),
    );

    return (
        <div className={"flex flex-col gap-2"}>
            <div className={"flex flex-wrap gap-2"}>
                <select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as Frequency)}
                    aria-label={"frequency"}
                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                >
                    {frequencies.map((f) => (
                        <option key={f} value={f}>{f}</option>
                    ))}
                </select>

                {frequency === "minutes" && (
                    <select
                        value={every}
                        onChange={(e) => setEvery(Number(e.target.value))}
                        aria-label={"interval"}
                        className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                    >
                        {everyOptions.map((n) => (
                            <option key={n} value={n}>
                                {n === 1 ? "every minute" : `every ${n} minutes`}
                            </option>
                        ))}
                    </select>
                )}

                {frequency === "weekly" && (
                    <select
                        value={dayOfWeek}
                        onChange={(e) => setDayOfWeek(Number(e.target.value))}
                        aria-label={"day of week"}
                        className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                    >
                        {DAY_NAMES.map((name, day) => (
                            <option key={day} value={day}>{name}</option>
                        ))}
                    </select>
                )}

                {frequency === "monthly" && (
                    <select
                        value={dayOfMonth}
                        onChange={(e) => setDayOfMonth(Number(e.target.value))}
                        aria-label={"day of month"}
                        className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                    >
                        {range(28, 1).map((day) => (
                            <option key={day} value={day}>day {day}</option>
                        ))}
                    </select>
                )}

                {frequency !== "minutes" && frequency !== "hourly" && (
                    <select
                        value={hour}
                        onChange={(e) => setHour(Number(e.target.value))}
                        aria-label={"hour"}
                        className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                    >
                        {range(24).map((h) => (
                            <option key={h} value={h}>{pad2(h)}h</option>
                        ))}
                    </select>
                )}

                {frequency !== "minutes" && (
                    <select
                        value={minute}
                        onChange={(e) => setMinute(Number(e.target.value))}
                        aria-label={"minute"}
                        className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                    >
                        {range(60).map((m) => (
                            <option key={m} value={m}>:{pad2(m)}</option>
                        ))}
                    </select>
                )}
            </div>

            <p className={"font-mono text-xs text-gray-400"}>{describeCron(cron)} — times are UTC</p>
            <input type={"hidden"} name={name} value={cron} />
        </div>
    );
}
