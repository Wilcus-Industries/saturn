import { cookies } from "next/headers";
import { MODEL_ID, REASONING_MODES } from "@/lib/agent";

// The Agent composer's last model + reasoning-effort pick. Cookies, not module
// state: they survive a reload and — the reason for cookies over localStorage —
// arrive server-side, so the first paint already shows the saved choice instead
// of flashing the default. Same call as the `sidebar` cookie.
//
// Written by app/dashboard/(shell)/agentComposer.tsx (names duplicated there as
// literals, like sidebar.tsx does). Validated here: a cookie is client-editable
// and its raw value renders as the selector's label.
export type AgentPrefs = { model?: string; reasoning?: string };

export async function agentPrefs(): Promise<AgentPrefs> {
    const jar = await cookies();
    const model = jar.get("agentModel")?.value;
    const reasoning = jar.get("agentEffort")?.value;
    return {
        model: model && MODEL_ID.test(model) ? model : undefined,
        reasoning: reasoning && REASONING_MODES.has(reasoning) ? reasoning : undefined,
    };
}
