"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cronMinIntervalMinutes, isValidCron } from "@/lib/cron";
import { db } from "@/lib/db";
import { type ActivationLevel, getActivation, limitsFor, requireUser } from "@/lib/subscription";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// actions are public POST endpoints — every one re-checks the session itself

// shared by create and update — the modal submits the same fields
function parseWorkflowFields(formData: FormData) {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new Error("Name is required");

    const emoji = String(formData.get("emoji") ?? "").trim() || "⚙️";
    const description = String(formData.get("description") ?? "").trim();

    // the builder emits plain 5-field expressions; reject anything else
    const cron = String(formData.get("cron") ?? "").trim();
    if (!isValidCron(cron)) throw new Error("Invalid cron expression");

    return { name, emoji, description, cron };
}

const floorLabel = (m: number) =>
    m === 1 ? "every minute" : m === 60 ? "hourly" : `every ${m} minutes`;

// tier cron floor — schedules tighter than the plan allows are rejected at save
function assertCronFloor(cron: string, level: ActivationLevel | null) {
    const floor = limitsFor(level).cronFloorMinutes;
    if (cronMinIntervalMinutes(cron) < floor) {
        throw new Error(
            `Your plan allows schedules down to ${floorLabel(floor)} — upgrade for tighter schedules`,
        );
    }
}

export async function createWorkflow(formData: FormData) {
    const { requestHeaders, session } = await requireUser();
    const { name, emoji, description, cron } = parseWorkflowFields(formData);

    const level = await getActivation(requestHeaders);
    assertCronFloor(cron, level);

    const cap = limitsFor(level).workflows;
    const { rows: countRows } = await db.query<{ count: string }>(
        "select count(*) from workflow where user_id = $1",
        [session.user.id],
    );
    if (Number(countRows[0].count) >= cap) {
        throw new Error(`Your plan allows ${cap} workflows — upgrade to add more`);
    }

    const { rows } = await db.query<{ id: string }>(
        `insert into workflow (user_id, name, emoji, description, cron)
         values ($1, $2, $3, $4, $5) returning id`,
        [session.user.id, name, emoji, description, cron],
    );

    redirect(`/dashboard/workflows/${rows[0].id}`);
}

// metadata only — the graph is saved separately by the designer
export async function updateWorkflow(formData: FormData) {
    const { requestHeaders, session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid workflow id");
    const { name, emoji, description, cron } = parseWorkflowFields(formData);
    assertCronFloor(cron, await getActivation(requestHeaders));

    const { rowCount } = await db.query(
        `update workflow
         set name = $1, emoji = $2, description = $3, cron = $4, updated_at = now()
         where id = $5 and user_id = $6`,
        [name, emoji, description, cron, id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    revalidatePath("/dashboard/workflows");
}

export async function deleteWorkflow(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid workflow id");

    const { rowCount } = await db.query(
        "delete from workflow where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    revalidatePath("/dashboard/workflows");
    // also lands the designer back on the list; on the list page it's a same-route refresh
    redirect("/dashboard/workflows");
}
