import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hasOpenrouterKey, listOpenrouterModels } from "@/lib/openrouter.server";
import { buildUserCatalog } from "@/lib/registry";
import { getUserRegistry } from "@/lib/registry.server";
import { getActivation, getSessionCached, limitsFor } from "@/lib/subscription";
import type { WorkflowRow } from "@/lib/workflow";
import Designer from "./designer";

// lives outside the (shell) route group on purpose — the designer takes over
// the full screen without the dashboard sidebar. session check lives here,
// not the layout.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WorkflowDesigner({ params }: PageProps<"/dashboard/workflows/[id]">) {
    const { id } = await params;
    // pre-validate before querying — junk ids would throw pg 22P02, not miss
    if (!UUID.test(id)) notFound();

    const requestHeaders = await headers();
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    const { rows } = await db.query(
        "select id, name, emoji, description, cron, graph from workflow where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!rows[0]) notFound();
    // pg parses jsonb, so row.graph arrives as a WorkflowGraph object
    const row = rows[0] as WorkflowRow;

    // user-registered mcp servers/skills join the static catalog as nodes
    const [registry, keyed, level] = await Promise.all([
        getUserRegistry(session.user.id),
        hasOpenrouterKey(session.user.id),
        getActivation(requestHeaders),
    ]);
    const userCatalog = buildUserCatalog(registry);
    // variables for the toolbox split — name + secret flag + whether a value is
    // set. For secrets the value never reaches the client (value is '' from the
    // guarded projection); regular variables carry their viewable plaintext.
    const variables = registry
        .filter((r) => r.kind === "variable")
        .map((r) => ({
            id: r.id,
            name: r.name,
            secret: r.secret,
            hasValue: r.has_token,
            value: r.value,
        }));
    // models list unlocks with built-in credits (any activated tier with an
    // allowance — level null gets none, matching getCreditUsage) or a BYOK key.
    // null = neither (toolbox hints at settings); [] = unlocked but fetch failed
    const openrouterModels =
        keyed || (level !== null && limitsFor(level).modelCredits > 0)
            ? await listOpenrouterModels()
            : null;

    return (
        <Designer
            workflow={row}
            userCatalog={userCatalog}
            variables={variables}
            openrouterModels={openrouterModels}
            cronFloorMinutes={limitsFor(level).cronFloorMinutes}
        />
    );
}
