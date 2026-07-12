import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ConnectAgent from "@/app/dashboard/connectAgent";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { baseUrl } from "@/lib/subscription";
import RunsGraph, { type RunDay } from "./runsGraph";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 84; // ~12 weeks — matches what the 50-runs-per-workflow retention keeps

// runs execute on a UTC schedule, so days bucket in UTC (same as the runs page).
// "today" comes from the DB clock — render must stay pure (react-hooks/purity)
function weekGrid(counts: Map<string, number>, today: string): RunDay[][] {
    const todayUtc = new Date(`${today}T00:00:00Z`).getTime();
    let start = todayUtc - (WINDOW_DAYS - 1) * DAY_MS;
    start -= new Date(start).getUTCDay() * DAY_MS; // align back to Sunday for whole columns

    const weeks: RunDay[][] = [];
    for (let t = start; t <= todayUtc; t += DAY_MS) {
        const date = new Date(t);
        if (date.getUTCDay() === 0) weeks.push([]);
        weeks[weeks.length - 1].push({
            date,
            count: counts.get(date.toISOString().slice(0, 10)) ?? 0,
        });
    }
    return weeks;
}

// lives outside the (saturn) route group on purpose — no planetary scene here.
// gated on session only, not activation level — Stripe redirects here right
// after checkout, often before the webhook has written the subscription row
export default async function Dashboard() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    const [{ rows: days }, { rows: stats }] = await Promise.all([
        // ::text sidesteps node-pg parsing bare dates in local time
        db.query<{ day: string; runs: number }>(
            `select (wr.started_at at time zone 'UTC')::date::text as day, count(*)::int as runs
             from workflow_run wr
             join workflow w on w.id = wr.workflow_id
             where w.user_id = $1 and wr.started_at >= now() - make_interval(days => $2)
             group by 1`,
            [session.user.id, WINDOW_DAYS],
        ),
        db.query<{ n: number; today: string }>(
            `select count(*) filter (where active)::int as n,
                    (now() at time zone 'UTC')::date::text as today
             from workflow where user_id = $1`,
            [session.user.id],
        ),
    ]);

    const totalRuns = days.reduce((sum, d) => sum + d.runs, 0);
    const weeks = weekGrid(new Map(days.map((d) => [d.day, d.runs])), stats[0].today);

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Overview</h1>

            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Activity</h2>
                <p className={"font-mono text-sm text-gray-400"}>
                    {totalRuns === 0
                        ? "no runs yet — activate a workflow or hit run in the designer"
                        : `${totalRuns} run${totalRuns === 1 ? "" : "s"} in the last 12 weeks · ` +
                          `${stats[0].n} active workflow${stats[0].n === 1 ? "" : "s"}`}
                </p>
                <RunsGraph weeks={weeks} />
            </section>

            <ConnectAgent baseUrl={baseUrl} />
        </div>
    );
}
