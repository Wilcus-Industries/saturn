// Integration node providers (client-safe). Each descriptor becomes one
// static CATALOG entry (lib/workflow.ts) and maps to one send function in
// lib/integrations.server.ts. Adding a provider = one descriptor here + one
// sender there; interpreter/designer/toolbox need no changes.
// Type-only imports from workflow.ts — workflow.ts value-imports this file,
// so a value import here would create a runtime cycle.
import type { ConfigField, NodeCategory } from "@/lib/workflow";

export const INTEGRATION_PREFIX = "integration:";

// the Blocks category an integration borrows its color from. Integrations all
// carry the "integration" NodeCategory, but paint like the Blocks group: a
// discord webhook in "data" looks like the print node. Keep these a subset of
// NodeCategory — entryStyles() colors every integration by this name. Toolbox
// subsections are headed by `app`, not by this.
export const INTEGRATION_SECTIONS = ["events", "logic", "data"] as const satisfies
    readonly NodeCategory[];
export type IntegrationSection = (typeof INTEGRATION_SECTIONS)[number];

export type IntegrationProvider = {
    id: string; // key suffix: "discord-webhook"
    label: string;
    app: string; // toolbox subheader within the Apps group — the app's name
    section: IntegrationSection; // the Blocks category this node's color comes from
    logoDomain: string; // favicon via entryIcon.tsx
    config: ConfigField[];
    // blank config fields validateGraphStrict warns about
    requiredConfig: string[];
};

export const INTEGRATIONS: IntegrationProvider[] = [
    {
        id: "discord-webhook",
        label: "send webhook",
        app: "discord",
        section: "data",
        logoDomain: "discord.com",
        config: [
            {
                id: "webhookUrl", label: "webhook url", input: "text",
                placeholder: "https://discord.com/api/webhooks/…",
            },
            { id: "message", label: "message", input: "text", overriddenBy: "message" },
        ],
        requiredConfig: ["webhookUrl"],
    },
];

export const integrationKey = (id: string) => `${INTEGRATION_PREFIX}${id}`;
export const integrationProviderId = (type: string) => type.slice(INTEGRATION_PREFIX.length);

export const INTEGRATIONS_BY_ID: Record<string, IntegrationProvider> = Object.fromEntries(
    INTEGRATIONS.map((p) => [p.id, p]),
);
