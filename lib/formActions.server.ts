// Shared helpers for the dashboard's server actions (settings / memory /
// sandboxes / workflows). Not a "use server" module itself — a plain util
// imported by those action files, which re-check the session themselves.
//
// Expected failures come back as a value the modal renders inline; a thrown
// error would only reach Next's generic error page (message redacted in prod).
import { db } from "@/lib/db";
import { UUID_RE } from "@/lib/registry";

// one canonical uuid shape for the whole app (lib/registry.ts), re-exported
// under the name these action files already use
export { UUID_RE as UUID };

export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 2000;

export type ActionResult = { error: string } | undefined;

export function toError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : "Something went wrong" };
}

export function requiredName(formData: FormData): string {
    const name = String(formData.get("name") ?? "").trim();
    if (!name || name.length > MAX_NAME) throw new Error("Name is required (max 60 chars)");
    return name;
}

// optional id field: present + valid uuid → update, absent → insert
export function optionalId(formData: FormData): string | null {
    const id = String(formData.get("id") ?? "").trim();
    if (!id) return null;
    if (!UUID_RE.test(id)) throw new Error("Invalid id");
    return id;
}

// count of a user's registry entries of one kind (cap checks live in callers)
export async function countKind(userId: string, kind: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
        "select count(*) from registry_entry where user_id = $1 and kind = $2",
        [userId, kind],
    );
    return Number(rows[0].count);
}
