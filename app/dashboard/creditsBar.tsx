// built-in model credits used/allowance bar — shared by settings and the
// overview usage panel. Callers guard on allowance > 0; this assumes it.
export default function CreditsBar({
    used,
    allowance,
    periodEnd,
}: {
    used: number;
    allowance: number;
    periodEnd: Date | null; // null → free tier rolling 30-day window
}) {
    return (
        <div className={"flex flex-col gap-2 border border-foreground/15 p-4"}>
            <div className={"flex items-baseline justify-between font-mono text-sm"}>
                <span>
                    {Math.min(used, allowance).toLocaleString("en-US")}
                    {" / "}
                    {allowance.toLocaleString("en-US")} credits used
                </span>
                {periodEnd ? (
                    <span className={"text-xs text-gray-400"}>
                        resets{" "}
                        {periodEnd.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                        })}
                    </span>
                ) : (
                    // free tier: rolling 30-day window, no fixed reset
                    <span className={"text-xs text-gray-400"}>past 30 days</span>
                )}
            </div>
            <div className={"h-1 w-full bg-foreground/15"}>
                <div
                    className={"h-full bg-foreground"}
                    style={{
                        width: `${Math.min((used / allowance) * 100, 100)}%`,
                    }}
                />
            </div>
        </div>
    );
}
