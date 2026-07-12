// Integration node providers (client-safe). Each descriptor becomes one
// static CATALOG entry (lib/workflow.ts) and maps to one send function in
// lib/integrations.server.ts. Adding a provider = one descriptor here + one
// sender there; interpreter/designer/toolbox need no changes.
// Type-only imports from workflow.ts — workflow.ts value-imports this file,
// so a value import here would create a runtime cycle.
import type { ConfigField } from "@/lib/workflow";

export const INTEGRATION_PREFIX = "integration:";

export type IntegrationProvider = {
    id: string; // key suffix: "discord-webhook"
    label: string;
    logoDomain: string; // favicon via entryIcon.tsx
    config: ConfigField[];
    // blank config fields validateGraphStrict warns about
    requiredConfig: string[];
};

export const INTEGRATIONS: IntegrationProvider[] = [
    {
        id: "discord-webhook",
        label: "discord webhook",
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
