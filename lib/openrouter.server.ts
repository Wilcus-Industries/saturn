// Server-side access to the user's OpenRouter key — the BYOK fallback used
// when a user has no built-in credits (free tier / allowance exhausted; see
// lib/credits.server.ts). The key is write-only — never return it to the
// client.
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

// outputModalities is architecture.output_modalities filtered to the values
// the designer understands — it drives the agent node's output select
export type OpenrouterModel = { id: string; name: string; outputModalities: string[] };

// public endpoint, deliberately unauthenticated: the response is the same
// for every user, so the shared Next data cache (1h revalidate) is safe.
// Failure degrades to [] — the toolbox falls back to the blank model chip
export async function listOpenrouterModels(): Promise<OpenrouterModel[]> {
    try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
            next: { revalidate: 3600 },
        });
        if (!res.ok) return [];
        const body: unknown = await res.json();
        const data =
            typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data)
                ? ((body as { data: unknown[] }).data as {
                      id?: unknown;
                      name?: unknown;
                      architecture?: { output_modalities?: unknown };
                  }[])
                : [];
        return data
            // 128 = the runner's MODEL_ID length cap
            .filter((m) => typeof m?.id === "string" && m.id.length > 0 && m.id.length <= 128)
            .slice(0, 1000)
            .map((m) => ({
                id: m.id as string,
                name: typeof m.name === "string" && m.name ? m.name : (m.id as string),
                outputModalities: Array.isArray(m.architecture?.output_modalities)
                    ? m.architecture.output_modalities.filter(
                          (x): x is string => x === "text" || x === "image",
                      )
                    : [],
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}
