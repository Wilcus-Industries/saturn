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

// 0 runs → empty; otherwise 4 buckets relative to the window max
function level(count: number, max: number): number {
    if (count <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

export default function RunsGraph({ weeks }: { weeks: RunDay[][] }) {
    const max = Math.max(1, ...weeks.flat().map((d) => d.count));

    return (
        <div className={"flex flex-col gap-2 overflow-x-auto"}>
            <div className={"flex gap-1"}>
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
            </div>
        </div>
    );
}
