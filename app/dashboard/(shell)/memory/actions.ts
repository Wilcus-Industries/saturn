"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { MAX_ENTRIES_PER_KIND } from "@/lib/registry";
import { invalidateUserRegistry } from "@/lib/registry.server";
import { getActivation, limitsFor, requireUser } from "@/lib/subscription";

// actions are public POST endpoints — every one re-checks the session itself

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;

// expected failures come back as a value the modal renders inline; a thrown
// error would only reach Next's generic error page (message redacted in prod)
type ActionResult = { error: string } | undefined;

function toError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : "Something went wrong" };
}

function requiredName(formData: FormData): string {
    const name = String(formData.get("name") ?? "").trim();
    if (!name || name.length > MAX_NAME) throw new Error("Name is required (max 60 chars)");
    return name;
}

// optional id field: present + valid uuid → update, absent → insert
function optionalId(formData: FormData): string | null {
    const id = String(formData.get("id") ?? "").trim();
    if (!id) return null;
    if (!UUID.test(id)) throw new Error("Invalid id");
    return id;
}

async function countMemoryStores(userId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
        "select count(*) from registry_entry where user_id = $1 and kind = 'memory'",
        [userId],
    );
    return Number(rows[0].count);
}

export async function saveMemoryStore(formData: FormData): Promise<ActionResult> {
    const { requestHeaders, session } = await requireUser();

    try {
        const id = optionalId(formData);
        const name = requiredName(formData);
        const emoji = String(formData.get("emoji") ?? "").trim() || "🧠";
        const description = String(formData.get("description") ?? "").trim();
        if (description.length > MAX_DESCRIPTION) throw new Error("Note too long");

        if (id) {
            const { rowCount } = await db.query(
                `update registry_entry
                 set name = $1, emoji = $2, description = $3, updated_at = now()
                 where id = $4 and user_id = $5 and kind = 'memory'`,
                [name, emoji, description, id, session.user.id],
            );
            if (!rowCount) throw new Error("Not found");
        } else {
            // tier cap on new stores; MAX_ENTRIES_PER_KIND is the absolute backstop
            const cap = limitsFor(await getActivation(requestHeaders)).memoryStores;
            const count = await countMemoryStores(session.user.id);
            if (count >= cap) {
                throw new Error(
                    `Your plan allows ${cap} memory store${cap === 1 ? "" : "s"} — upgrade to add more`,
                );
            }
            if (count >= MAX_ENTRIES_PER_KIND) {
                throw new Error(`Limit of ${MAX_ENTRIES_PER_KIND} memory entries reached`);
            }
            await db.query(
                `insert into registry_entry (user_id, kind, name, emoji, description)
                 values ($1, 'memory', $2, $3, $4)`,
                [session.user.id, name, emoji, description],
            );
        }
    } catch (err) {
        return toError(err);
    }

    invalidateUserRegistry(session.user.id);
    revalidatePath("/dashboard/memory");
}

export async function deleteMemoryStore(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");

    // memory_item rows cascade on the registry_entry FK
    const { rowCount } = await db.query(
        "delete from registry_entry where id = $1 and user_id = $2 and kind = 'memory'",
        [id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    invalidateUserRegistry(session.user.id);
    revalidatePath("/dashboard/memory");
}

// wipe all items in one store, keeping the store itself
export async function wipeMemoryStore(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");

    // ownership: the store must exist, be a memory kind, and belong to the user
    const { rows } = await db.query(
        "select id from registry_entry where id = $1 and user_id = $2 and kind = 'memory'",
        [id, session.user.id],
    );
    if (!rows[0]) throw new Error("Not found");

    await db.query("delete from memory_item where entry_id = $1 and user_id = $2", [
        id,
        session.user.id,
    ]);

    // item ops don't touch the registry cache (store rows are unchanged)
    revalidatePath("/dashboard/memory");
    revalidatePath(`/dashboard/memory/${id}`);
}

export async function deleteMemoryItem(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");
    // the store the item belongs to, so we can revalidate its page
    const entryId = String(formData.get("entryId") ?? "");

    // user_id scope is sufficient — entry ownership is implied by the item's FK
    const { rowCount } = await db.query(
        "delete from memory_item where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    revalidatePath("/dashboard/memory");
    if (UUID.test(entryId)) revalidatePath(`/dashboard/memory/${entryId}`);
}
