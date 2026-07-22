import Link from "next/link";
import CreditsBar from "@/app/dashboard/creditsBar";
import { isPaidPlan, limitsFor } from "@/lib/subscription";
import type { CreditUsage } from "@/lib/credits.server"; // type-only — keeps pg out of the client graph

// overview usage & limits panel: built-in credits bar + workflow/mcp count
// meters against the tier caps. Presentational; the page resolves the data.
// Self-hosted: no plans, no caps (Infinity) — meters show plain counts, the
// header carries a self-hosted badge, and the credits/upgrade chrome is hidden.
export default function UsagePanel({
    credits,
    workflowCount,
    mcpCount,
    memoryCount,
    sandboxCount,
    selfHosted = false,
}: {
    credits: CreditUsage;
    workflowCount: number;
    mcpCount: number;
    memoryCount: number;
    sandboxCount: number;
    selfHosted?: boolean;
}) {
    const limits = limitsFor(credits.level); // null level → free caps by design
    const paid = credits.level ? isPaidPlan(credits.level) : false;

    // one row per tracked resource; caps + progress bars only render off self-hosted
    const meters: { label: string; count: number; cap: number }[] = [
        { label: "workflows", count: workflowCount, cap: limits.workflows },
        { label: "mcp servers", count: mcpCount, cap: limits.mcpServers },
        { label: "memory stores", count: memoryCount, cap: limits.memoryStores },
        { label: "linux sandboxes", count: sandboxCount, cap: limits.sandboxes },
    ];

    return (
        <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <div className={"flex items-baseline gap-3"}>
                <h2 className={"font-mono text-xl"}>Usage &amp; limits</h2>
                {selfHosted ? (
                    <span
                        className={`ml-auto rounded-full border border-foreground/25 px-2 py-0.5
                            font-mono text-xs text-gray-400`}
                    >
                        self-hosted
                    </span>
                ) : (
                    <span className={"ml-auto font-mono text-sm text-gray-400"}>
                        {credits.level
                            ? `Saturn ${credits.level.charAt(0).toUpperCase()}${credits.level.slice(1)}`
                            : "no plan"}
                    </span>
                )}
            </div>

            {credits.allowance > 0 ? (
                <CreditsBar
                    used={credits.used}
                    allowance={credits.allowance}
                    periodEnd={credits.periodEnd}
                />
            ) : (
                // level null — also covers the just-returned-from-Stripe window
                // before the webhook writes the subscription row. Hidden entirely
                // under self-hosted (no plans to pick).
                !selfHosted && (
                    <p className={"font-mono text-sm text-gray-400"}>
                        no plan yet —{" "}
                        <Link href={"/activate"} className={"text-blue-400"}>
                            pick a plan
                        </Link>{" "}
                        for built-in model credits
                    </p>
                )
            )}

            {meters.map((m) => (
                <div key={m.label} className={"flex flex-col gap-2"}>
                    <div className={"flex items-baseline justify-between font-mono text-sm"}>
                        <span>{m.label}</span>
                        <span>{selfHosted ? m.count : `${m.count} / ${m.cap}`}</span>
                    </div>
                    {!selfHosted && (
                        <div className={"h-1 w-full bg-foreground/15"}>
                            <div
                                className={"h-full bg-foreground"}
                                style={{ width: `${Math.min((m.count / m.cap) * 100, 100)}%` }}
                            />
                        </div>
                    )}
                </div>
            ))}

            {!selfHosted && (
                <Link href={"/dashboard/upgrade"} className={"font-mono text-sm text-blue-400"}>
                    {paid ? "Manage" : "Upgrade"} →
                </Link>
            )}
        </section>
    );
}
