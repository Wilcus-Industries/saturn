"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
    type ActionResult,
    countKind,
    MAX_DESCRIPTION,
    optionalId,
    requiredName,
    toError,
    UUID,
} from "@/lib/formActions.server";
import { MAX_ENTRIES_PER_KIND } from "@/lib/registry";
import { invalidateUserRegistry } from "@/lib/registry.server";
import { destroySandbox, resetSandbox, stopSandboxNow } from "@/lib/sandbox.server";
import { getActivation, limitsFor, requireUser } from "@/lib/subscription";

// actions are public POST endpoints — every one re-checks the session itself

// no podman calls here — the container + volume are created lazily on the
// first sandbox tool call, not at save time
export async function saveSandbox(formData: FormData): Promise<ActionResult> {
    const { requestHeaders, session } = await requireUser();

    try {
        const id = optionalId(formData);
        const name = requiredName(formData);
        const description = String(formData.get("description") ?? "").trim();
        if (description.length > MAX_DESCRIPTION) throw new Error("Description too long");

        if (id) {
            const { rowCount } = await db.query(
                `update registry_entry
                 set name = $1, description = $2, updated_at = now()
                 where id = $3 and user_id = $4 and kind = 'sandbox'`,
                [name, description, id, session.user.id],
            );
            if (!rowCount) throw new Error("Not found");
        } else {
            // tier cap on new sandboxes; MAX_ENTRIES_PER_KIND is the absolute backstop
            const cap = limitsFor(await getActivation(requestHeaders)).sandboxes;
            const count = await countKind(session.user.id, "sandbox");
            if (count >= cap) {
                throw new Error(
                    `Your plan allows ${cap} linux sandbox${cap === 1 ? "" : "es"} — upgrade to add more`,
                );
            }
            if (count >= MAX_ENTRIES_PER_KIND) {
                throw new Error(`Limit of ${MAX_ENTRIES_PER_KIND} sandbox entries reached`);
            }
            await db.query(
                `insert into registry_entry (user_id, kind, name, description)
                 values ($1, 'sandbox', $2, $3)`,
                [session.user.id, name, description],
            );
        }
    } catch (err) {
        return toError(err);
    }

    invalidateUserRegistry(session.user.id);
    revalidatePath("/dashboard/sandboxes");
}

export async function deleteSandbox(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");

    // ownership check before we touch any runtime resource
    const { rows } = await db.query(
        "select id from registry_entry where id = $1 and user_id = $2 and kind = 'sandbox'",
        [id, session.user.id],
    );
    if (!rows[0]) throw new Error("Not found");

    // best-effort teardown of the container + volume BEFORE the DB row goes
    // away — if the runtime is down this can orphan the volume (GC runbook in
    // deploy/sandboxes.md); never throws.
    await destroySandbox(id);

    const { rowCount } = await db.query(
        "delete from registry_entry where id = $1 and user_id = $2 and kind = 'sandbox'",
        [id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    invalidateUserRegistry(session.user.id);
    revalidatePath("/dashboard/sandboxes");
}

// wipes all files in /work by removing the container + volume (recreated
// lazily on next use); surfaces the reset error value inline
export async function resetSandboxAction(formData: FormData): Promise<ActionResult> {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) return { error: "Invalid id" };

    // ownership: the sandbox must exist, be a sandbox kind, and belong to the user
    const { rows } = await db.query(
        "select id from registry_entry where id = $1 and user_id = $2 and kind = 'sandbox'",
        [id, session.user.id],
    );
    if (!rows[0]) return { error: "Not found" };

    const result = await resetSandbox(id);
    revalidatePath("/dashboard/sandboxes");
    if (result.error) return { error: result.error };
}

// stops a running sandbox now (best-effort, never throws)
export async function stopSandboxAction(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");

    const { rows } = await db.query(
        "select id from registry_entry where id = $1 and user_id = $2 and kind = 'sandbox'",
        [id, session.user.id],
    );
    if (!rows[0]) throw new Error("Not found");

    await stopSandboxNow(id);
    revalidatePath("/dashboard/sandboxes");
}
