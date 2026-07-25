import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { agentPrefs } from "@/app/dashboard/agentPrefs";
import { db } from "@/lib/db";
import { githubAppConfigured, listInstallations } from "@/lib/githubApp.server";
import { hasOpenrouterKey, listOpenrouterModels } from "@/lib/openrouter.server";
import { buildUserCatalog, UUID_RE } from "@/lib/registry";
import { getUserRegistry } from "@/lib/registry.server";
import { SELF_HOSTED } from "@/lib/selfhost";
import { getActivation, getSessionCached, limitsFor } from "@/lib/subscription";
import type { WorkflowRow } from "@/lib/workflow";
import Designer, { type GithubLink } from "./designer";

// lives outside the (shell) route group on purpose — the designer takes over
// the full screen without the dashboard sidebar. session check lives here,
// not the layout.
export default async function WorkflowDesigner({ params }: PageProps<"/dashboard/workflows/[id]">) {
    const { id } = await params;
    // pre-validate before querying — junk ids would throw pg 22P02, not miss
    if (!UUID_RE.test(id)) notFound();

    const requestHeaders = await headers();
    const session = await getSessionCached();
    if (!session?.user) notFound();

    // github event nodes only fire once the owner links the central GitHub App;
    // skip the installation query entirely when the app isn't configured
    const githubConfigured = githubAppConfigured();
    // user-registered mcp servers/skills join the static catalog as nodes; the
    // workflow row rides the same Promise.all so the page pays one round trip
    const [{ rows }, registry, keyed, level, installations] = await Promise.all([
        db.query(
            "select id, name, emoji, description, graph from workflow where id = $1 and user_id = $2",
            [id, session.user.id],
        ),
        getUserRegistry(session.user.id),
        hasOpenrouterKey(session.user.id),
        getActivation(requestHeaders),
        githubConfigured ? listInstallations(session.user.id) : Promise.resolve([]),
    ]);
    if (!rows[0]) notFound();
    // pg parses jsonb, so row.graph arrives as a WorkflowGraph object
    const row = rows[0] as WorkflowRow;
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
    // BYOK only: the models list unlocks iff the user has an OpenRouter key.
    // null = locked (toolbox hints at settings); [] = unlocked but fetch failed
    const openrouterModels = keyed ? await listOpenrouterModels() : null;

    // github event nodes blank out unless the owner has a linked installation:
    // "unconfigured" = no app on this server, "unlinked" = app but no install,
    // "linked" = ready. Drives the toolbox chip enable/hint + validation warn.
    const githubLink: GithubLink = !githubConfigured
        ? "unconfigured"
        : installations.length
          ? "linked"
          : "unlinked";

    return (
        <Designer
            workflow={row}
            userCatalog={userCatalog}
            variables={variables}
            openrouterModels={openrouterModels}
            agentPrefs={await agentPrefs()}
            cronFloorMinutes={limitsFor(level).cronFloorMinutes}
            selfHosted={SELF_HOSTED}
            githubLink={githubLink}
        />
    );
}
