import { db } from "@/lib/db";
import type { WorkflowGraph } from "@/lib/workflow";

// Starter graph seeded for every new user: start → agent → print, with a
// string node feeding the prompt and a model node feeding the model port.
// Static catalog nodes only — no user-registry dependency.
const EXAMPLE_GRAPH: WorkflowGraph = {
    nodes: [
        { id: "start", type: "start", x: 48, y: 120, config: {} },
        {
            id: "prompt",
            type: "string",
            x: 48,
            y: 288,
            config: {
                value: "Write a haiku about the morning sky over Saturn.",
            },
        },
        {
            id: "model",
            type: "model",
            x: 168,
            y: 432,
            config: { model: "openai/gpt-4o-mini", preset: "1" },
        },
        {
            id: "agent",
            type: "agent",
            x: 312,
            y: 120,
            config: {
                system: "You are a poet. Reply with only the haiku, nothing else.",
                output: "text",
            },
        },
        { id: "print", type: "print", x: 576, y: 120, config: { message: "" } },
    ],
    edges: [
        { id: "e1", from: { nodeId: "start", portId: "out" }, to: { nodeId: "agent", portId: "in" }, kind: "flow" },
        { id: "e2", from: { nodeId: "prompt", portId: "out" }, to: { nodeId: "agent", portId: "prompt" }, kind: "value" },
        { id: "e3", from: { nodeId: "model", portId: "model" }, to: { nodeId: "agent", portId: "model" }, kind: "value" },
        { id: "e4", from: { nodeId: "agent", portId: "out" }, to: { nodeId: "print", portId: "in" }, kind: "flow" },
        { id: "e5", from: { nodeId: "agent", portId: "result" }, to: { nodeId: "print", portId: "value" }, kind: "value" },
    ],
};

// Called from better-auth's user.create.after hook (lib/auth.ts). Never
// throws: the after-hook is awaited inline by better-auth, so an error here
// would surface in the OAuth sign-in callback and break signup.
export async function seedExampleWorkflow(userId: string): Promise<void> {
    try {
        await db.query(
            `insert into workflow (user_id, name, emoji, description, cron, graph, active)
             values ($1, $2, $3, $4, $5, $6, false)`,
            [
                userId,
                "Daily haiku",
                "🪐",
                "Example workflow: an agent writes a haiku and prints it. Open it in the designer and press run, or switch it active to run daily at 09:00 UTC.",
                "0 9 * * *",
                JSON.stringify(EXAMPLE_GRAPH),
            ],
        );
    } catch (err) {
        console.error("example workflow seed failed", err);
    }
}
