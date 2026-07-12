// GitHub-style contribution heatmap of workflow runs per day. Pure server
// markup — hover detail rides the native title attribute, no client JS.

export type RunDay = { date: Date; count: number };

// literal class strings — Tailwind can't see computed names
const LEVEL_CLASSES = [
    "bg-foreground/10",
    "bg-green-500/25",
    "bg-green-500/50",
    "bg-green-500/75",
    "bg-green-500",
] as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// rows run Sun..Sat; label only mon/wed/fri like GitHub (blank rows stay aligned)
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_LABELS = ["", "mon", "", "wed", "", "fri", ""];

// 0 runs → empty; otherwise 4 buckets relative to the window max
function level(count: number, max: number): number {
    if (count <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

// current run streak: walk the flattened cells (ascending, last = today) backwards
// counting days with runs. Zero stops the walk — except today itself, which may
// simply not have fired yet, so a trailing empty today is skipped, not a break.
function currentStreak(cells: RunDay[]): number {
    let streak = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].count > 0) streak++;
        else if (i === cells.length - 1) continue; // today, no runs yet — don't break
        else break;
    }
    return streak;
}

export default function RunsGraph({ weeks }: { weeks: RunDay[][] }) {
    const cells = weeks.flat();
    const max = Math.max(1, ...cells.map((d) => d.count));
    const streak = currentStreak(cells);

    return (
        <div className={"flex flex-col gap-2 overflow-x-auto"}>
            <div className={"flex gap-1"}>
                <div className={"flex flex-col gap-1"}>
                    <span className={"h-4"} />
                    {WEEKDAY_LABELS.map((label, i) => (
                        <span
                            key={WEEKDAY_KEYS[i]}
                            className={"h-3 pr-1 text-right font-mono text-[10px] leading-3 text-gray-400"}
                        >
                            {label}
                        </span>
                    ))}
                </div>
                {weeks.map((week, i) => {
                    const month = week[0].date.getUTCMonth();
                    // label a column when the month changes (skip a cramped first label)
                    const showLabel =
                        i > 0 && month !== weeks[i - 1][0].date.getUTCMonth();

                    return (
                        <div key={week[0].date.toISOString()} className={"flex flex-col gap-1"}>
                            <span
                                className={`h-4 w-3 overflow-visible font-mono text-[10px]
                                    whitespace-nowrap text-gray-400`}
                            >
                                {showLabel ? MONTHS[month] : ""}
                            </span>
                            {week.map((day) => (
                                <div
                                    key={day.date.toISOString()}
                                    title={`${day.count} run${day.count === 1 ? "" : "s"} · ${day.date.toISOString().slice(0, 10)}`}
                                    className={`h-3 w-3 ${LEVEL_CLASSES[level(day.count, max)]}`}
                                />
                            ))}
                        </div>
                    );
                })}
            </div>
            <div className={"flex items-center gap-1 font-mono text-[10px] text-gray-400"}>
                <span className={"mr-1"}>less</span>
                {LEVEL_CLASSES.map((cls) => (
                    <div key={cls} className={`h-3 w-3 ${cls}`} />
                ))}
                <span className={"ml-1"}>more</span>
                {streak > 0 && <span className={"ml-auto"}>{streak}-day streak</span>}
            </div>
        </div>
    );
}
