import { redirect } from "next/navigation";
import ConnectAgent from "@/app/dashboard/connectAgent";
import { getCreditUsage } from "@/lib/credits.server";
import { db } from "@/lib/db";
import { baseUrl, getSessionCached } from "@/lib/subscription";
import GettingStarted, { type ChecklistStep } from "./gettingStarted";
import RecentRuns, { type RecentRun } from "./recentRuns";
import RunsGraph, { type RunDay } from "./runsGraph";
import UsagePanel from "./usagePanel";

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
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    const [{ rows: days }, { rows: workflows }, { rows: recent }, { rows: meta }, agentRes, credits] =
        await Promise.all([
            // ::text sidesteps node-pg parsing bare dates in local time
            db.query<{ day: string; runs: number }>(
                `select (wr.started_at at time zone 'UTC')::date::text as day, count(*)::int as runs
                 from workflow_run wr
                 join workflow w on w.id = wr.workflow_id
                 where w.user_id = $1 and wr.started_at >= now() - make_interval(days => $2)
                 group by 1`,
                [session.user.id, WINDOW_DAYS],
            ),
            // all workflows (≤100 at the top tier cap) — feeds counts, checklist
            db.query<{ id: string; name: string; emoji: string; active: boolean }>(
                `select id, name, emoji, active
                 from workflow where user_id = $1 order by created_at desc`,
                [session.user.id],
            ),
            // recent runs feed
            db.query<RecentRun>(
                `select wr.id, wr.trigger, wr.status, wr.started_at,
                        w.id as workflow_id, w.name as workflow_name, w.emoji as workflow_emoji
                 from workflow_run wr
                 join workflow w on w.id = wr.workflow_id
                 where w.user_id = $1
                 order by wr.started_at desc
                 limit 10`,
                [session.user.id],
            ),
            // DB clock (render purity, same reason as before) + mcp count for checklist/limits
            db.query<{ today: string; db_now: Date; mcp_count: number }>(
                `select (now() at time zone 'UTC')::date::text as today,
                        now() as db_now,
                        (select count(*)::int from registry_entry
                          where user_id = $1 and kind = 'mcp') as mcp_count`,
                [session.user.id],
            ),
            // better-auth-owned table (camelCase quoted, like the consent page's "oauthApplication"
            // query); catch → null degrades the checklist step away if the mcp-plugin migration
            // hasn't run
            db.query<{ connected: boolean }>(
                `select exists(select 1 from "oauthAccessToken" where "userId" = $1) as connected`,
                [session.user.id],
            ).catch(() => null),
            // credits + effective level, headless
            getCreditUsage(session.user.id),
        ]);

    const now = meta[0].db_now;
    const activeCount = workflows.filter((w) => w.active).length;
    const totalRuns = days.reduce((sum, d) => sum + d.runs, 0);
    const weeks = weekGrid(new Map(days.map((d) => [d.day, d.runs])), meta[0].today);

    const steps: ChecklistStep[] = [
        { label: "pick a plan", href: "/activate", done: credits.level !== null },
        { label: "add an MCP server", href: "/dashboard/settings", done: meta[0].mcp_count > 0 },
        // every user gets the seeded inactive example workflow, so "create" would
        // always read done; "activate" is the real first step
        { label: "activate a workflow", href: "/dashboard/workflows", done: workflows.some((w) => w.active) },
        { label: "run a workflow", href: "/dashboard/workflows", done: recent.length > 0 },
        // omitted when the mcp-plugin migration hasn't run (query caught → null)
        ...(agentRes !== null
            ? [
                  {
                      label: "connect an external agent",
                      href: "#connect-agent",
                      done: agentRes.rows[0].connected,
                  },
              ]
            : []),
    ];

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Overview</h1>

            <GettingStarted steps={steps} />

            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Activity</h2>
                <p className={"font-mono text-sm text-gray-400"}>
                    {totalRuns === 0
                        ? "no runs yet — activate a workflow or hit run in the designer"
                        : `${totalRuns} run${totalRuns === 1 ? "" : "s"} in the last 12 weeks · ` +
                          `${activeCount} active workflow${activeCount === 1 ? "" : "s"}`}
                </p>
                <RunsGraph weeks={weeks} />
            </section>

            <RecentRuns runs={recent} now={now} />

            <UsagePanel credits={credits} workflowCount={workflows.length} mcpCount={meta[0].mcp_count} />

            <ConnectAgent baseUrl={baseUrl} />
        </div>
    );
}
