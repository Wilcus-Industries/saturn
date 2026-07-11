import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasOpenrouterKey, listOpenrouterModels } from "@/lib/openrouter.server";
import { buildUserCatalog } from "@/lib/registry";
import { getUserRegistry } from "@/lib/registry.server";
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
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    const { rows } = await db.query(
        "select id, name, emoji, description, cron, graph from workflow where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!rows[0]) notFound();
    // pg parses jsonb, so row.graph arrives as a WorkflowGraph object
    const row = rows[0] as WorkflowRow;

    // user-registered mcp servers/skills join the static catalog as nodes
    const [userCatalog, keyed] = await Promise.all([
        getUserRegistry(session.user.id).then(buildUserCatalog),
        hasOpenrouterKey(session.user.id),
    ]);
    // null = no key (toolbox hints at settings); [] = key set but fetch failed
    const openrouterModels = keyed ? await listOpenrouterModels() : null;

    return <Designer workflow={row} userCatalog={userCatalog} openrouterModels={openrouterModels} />;
}
