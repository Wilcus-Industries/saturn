// Server-side access to the user's OpenRouter key. TEMPORARY: this is a
// stopgap so workflows can reach models until the built-in token system
// lands. The key is write-only — never return it to the client.
import { db } from "@/lib/db";

export async function getOpenrouterKey(userId: string): Promise<string | null> {
    const { rows } = await db.query<{ openrouter_key: string }>(
        "select openrouter_key from user_secret where user_id = $1",
        [userId],
    );
    return rows[0]?.openrouter_key || null;
}

// safe for server components rendering client-visible UI
export async function hasOpenrouterKey(userId: string): Promise<boolean> {
    const { rows } = await db.query(
        "select 1 from user_secret where user_id = $1 and openrouter_key <> ''",
        [userId],
    );
    return rows.length > 0;
}
