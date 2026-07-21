import Link from "next/link";
import CreditsBar from "@/app/dashboard/creditsBar";
import { isPaidPlan, limitsFor } from "@/lib/subscription";
import type { CreditUsage } from "@/lib/credits.server"; // type-only — keeps pg out of the client graph

// overview usage & limits panel: built-in credits bar + workflow/mcp count
// meters against the tier caps. Presentational; the page resolves the data.
export default function UsagePanel({
    credits,
    workflowCount,
    mcpCount,
    memoryCount,
    sandboxCount,
}: {
    credits: CreditUsage;
    workflowCount: number;
    mcpCount: number;
    memoryCount: number;
    sandboxCount: number;
}) {
    const limits = limitsFor(credits.level); // null level → free caps by design
    const paid = credits.level ? isPaidPlan(credits.level) : false;

    return (
        <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <div className={"flex items-baseline gap-3"}>
                <h2 className={"font-mono text-xl"}>Usage &amp; limits</h2>
                <span className={"ml-auto font-mono text-sm text-gray-400"}>
                    {credits.level
                        ? `Saturn ${credits.level.charAt(0).toUpperCase()}${credits.level.slice(1)}`
                        : "no plan"}
                </span>
            </div>

            {credits.allowance > 0 ? (
                <CreditsBar
                    used={credits.used}
                    allowance={credits.allowance}
                    periodEnd={credits.periodEnd}
                />
            ) : (
                // level null — also covers the just-returned-from-Stripe window
                // before the webhook writes the subscription row
                <p className={"font-mono text-sm text-gray-400"}>
                    no plan yet —{" "}
                    <Link href={"/activate"} className={"text-blue-400"}>
                        pick a plan
                    </Link>{" "}
                    for built-in model credits
                </p>
            )}

            <div className={"flex flex-col gap-2"}>
                <div className={"flex items-baseline justify-between font-mono text-sm"}>
                    <span>workflows</span>
                    <span>
                        {workflowCount} / {limits.workflows}
                    </span>
                </div>
                <div className={"h-1 w-full bg-foreground/15"}>
                    <div
                        className={"h-full bg-foreground"}
                        style={{
                            width: `${Math.min((workflowCount / limits.workflows) * 100, 100)}%`,
                        }}
                    />
                </div>
            </div>

            <div className={"flex flex-col gap-2"}>
                <div className={"flex items-baseline justify-between font-mono text-sm"}>
                    <span>mcp servers</span>
                    <span>
                        {mcpCount} / {limits.mcpServers}
                    </span>
                </div>
                <div className={"h-1 w-full bg-foreground/15"}>
                    <div
                        className={"h-full bg-foreground"}
                        style={{
                            width: `${Math.min((mcpCount / limits.mcpServers) * 100, 100)}%`,
                        }}
                    />
                </div>
            </div>

            <div className={"flex flex-col gap-2"}>
                <div className={"flex items-baseline justify-between font-mono text-sm"}>
                    <span>memory stores</span>
                    <span>
                        {memoryCount} / {limits.memoryStores}
                    </span>
                </div>
                <div className={"h-1 w-full bg-foreground/15"}>
                    <div
                        className={"h-full bg-foreground"}
                        style={{
                            width: `${Math.min((memoryCount / limits.memoryStores) * 100, 100)}%`,
                        }}
                    />
                </div>
            </div>

            <div className={"flex flex-col gap-2"}>
                <div className={"flex items-baseline justify-between font-mono text-sm"}>
                    <span>linux sandboxes</span>
                    <span>
                        {sandboxCount} / {limits.sandboxes}
                    </span>
                </div>
                <div className={"h-1 w-full bg-foreground/15"}>
                    <div
                        className={"h-full bg-foreground"}
                        style={{
                            width: `${Math.min((sandboxCount / limits.sandboxes) * 100, 100)}%`,
                        }}
                    />
                </div>
            </div>

            <Link
                href={"/dashboard/upgrade"}
                className={"font-mono text-sm text-blue-400"}
            >
                {paid ? "Manage" : "Upgrade"} →
            </Link>
        </section>
    );
}
