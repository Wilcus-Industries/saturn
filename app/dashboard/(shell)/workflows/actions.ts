"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getActivation, limitsFor, requireUser } from "@/lib/subscription";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// actions are public POST endpoints — every one re-checks the session itself

// expected failures come back as a value the modal renders inline; a thrown
// error would only reach Next's generic error page (message redacted in prod)
type ActionResult = { error: string } | undefined;

function toError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : "Something went wrong" };
}

// shared by create and update — the modal submits the same fields. The
// schedule now lives in a "scheduled to run" node in the graph, not here.
function parseWorkflowFields(formData: FormData) {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new Error("Name is required");

    const emoji = String(formData.get("emoji") ?? "").trim() || "⚙️";
    const description = String(formData.get("description") ?? "").trim();

    return { name, emoji, description };
}

// new workflows open on an empty canvas — the user drags in an event node
const EMPTY_GRAPH = JSON.stringify({ nodes: [], edges: [] });

export async function createWorkflow(formData: FormData): Promise<ActionResult> {
    const { requestHeaders, session } = await requireUser();

    let id: string;
    try {
        const { name, emoji, description } = parseWorkflowFields(formData);

        const level = await getActivation(requestHeaders);
        const cap = limitsFor(level).workflows;
        const { rows: countRows } = await db.query<{ count: string }>(
            "select count(*) from workflow where user_id = $1",
            [session.user.id],
        );
        if (Number(countRows[0].count) >= cap) {
            throw new Error(`Your plan allows ${cap} workflows — upgrade to add more`);
        }

        const { rows } = await db.query<{ id: string }>(
            `insert into workflow (user_id, name, emoji, description, graph)
             values ($1, $2, $3, $4, $5) returning id`,
            [session.user.id, name, emoji, description, EMPTY_GRAPH],
        );
        id = rows[0].id;
    } catch (err) {
        return toError(err);
    }

    // redirect throws internally — must run outside the try/catch
    redirect(`/dashboard/workflows/${id}`);
}

// metadata only — the graph (and its schedule) is saved by the designer
export async function updateWorkflow(formData: FormData): Promise<ActionResult> {
    const { session } = await requireUser();

    try {
        const id = String(formData.get("id") ?? "");
        if (!UUID.test(id)) throw new Error("Invalid workflow id");
        const { name, emoji, description } = parseWorkflowFields(formData);

        const { rowCount } = await db.query(
            `update workflow
             set name = $1, emoji = $2, description = $3, updated_at = now()
             where id = $4 and user_id = $5`,
            [name, emoji, description, id, session.user.id],
        );
        if (!rowCount) throw new Error("Not found");
    } catch (err) {
        return toError(err);
    }

    revalidatePath("/dashboard/workflows");
}

// active gates scheduled execution only — manual/test runs still work when off.
// Explicit desired state (not a flip) so a double-click stays idempotent.
export async function setWorkflowActive(id: string, active: boolean): Promise<ActionResult> {
    const { session } = await requireUser();

    try {
        if (!UUID.test(id)) throw new Error("Invalid workflow id");
        const { rowCount } = await db.query(
            `update workflow set active = $1, updated_at = now()
             where id = $2 and user_id = $3`,
            [active === true, id, session.user.id],
        );
        if (!rowCount) throw new Error("Not found");
    } catch (err) {
        return toError(err);
    }

    revalidatePath("/dashboard/workflows");
}

export async function deleteWorkflow(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid workflow id");

    // idempotent: a row already deleted elsewhere (another tab) is not an error
    await db.query("delete from workflow where id = $1 and user_id = $2", [
        id,
        session.user.id,
    ]);

    revalidatePath("/dashboard/workflows");
    // also lands the designer back on the list; on the list page it's a same-route refresh
    redirect("/dashboard/workflows");
}
