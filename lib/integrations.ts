// Platform extensions (client-safe). Each PlatformExtension bundles one app's
// outbound `actions` (message nodes → src-tauri/src/integrations.rs senders)
// and inbound `events` (trigger nodes, delivered by the Rust listeners:
// src-tauri/src/gateway.rs, telegram.rs, github.rs). Adding a platform = one
// descriptor here plus its senders/handlers in Rust; interpreter/designer/
// toolbox derive everything from the flat views at the bottom.
// Type-only imports from workflow.ts — workflow.ts value-imports this file,
// so a value import here would create a runtime cycle.
import type { ConfigField, NodeCategory } from "@/lib/workflow";

export const INTEGRATION_PREFIX = "integration:";
export const EVENT_PREFIX = "event:";

// the Blocks category an integration borrows its color from. Integrations all
// carry the "integration" NodeCategory, but paint like the Blocks group: a
// discord webhook in "data" looks like the print node. Keep these a subset of
// NodeCategory — entryStyles() colors every integration by this name. Toolbox
// subsections are headed by `app`, not by this.
export const INTEGRATION_SECTIONS = ["events", "logic", "data"] as const satisfies
    readonly NodeCategory[];
type IntegrationSection = (typeof INTEGRATION_SECTIONS)[number];

// one outbound message node type. app/logoDomain live on the owning
// PlatformExtension and get merged back into the flat INTEGRATIONS view.
type IntegrationAction = {
    id: string; // key suffix: "discord-webhook"
    label: string;
    section: IntegrationSection; // the Blocks category this node's color comes from
    config: ConfigField[];
    // blank config fields validate_graph warns about (workflow.rs); emitted
    // into catalog.json by scripts/gen-catalog.mjs, which is how Rust reads them
    requiredConfig: string[];
    // single value output port for read-style actions (e.g. fetched messages
    // as a JSON string); the interpreter stashes the sender's result under it
    output?: { id: string; label: string };
};

// one inbound trigger node type. Its node key is eventNodeKey(id) and its
// catalog category is "events", so it renders/behaves like the schedule node,
// but delivery is real-time (no cron). The payload SHAPE is not described here:
// it is defined once, in Rust, by the builder its transport dispatches through
// (gateway.rs/telegram.rs/github.rs), and a designer test run seeds event nodes
// from those same builders via `events::sample_payload`.

type ExtensionEvent = {
    id: string; // key suffix: "discord-mentioned"
    label: string;
    emoji?: string; // fallback node icon when logoDomain has no favicon
    config: ConfigField[];
    // blank config fields validate_graph warns about (workflow.rs); emitted
    // into catalog.json by scripts/gen-catalog.mjs, which is how Rust reads them
    requiredConfig: string[];
};

// one platform (an app) grouping its actions + events. app + logoDomain are
// shared by every node of the platform and merged into the flat views.
type PlatformExtension = {
    id: string; // platform id, e.g. "discord"
    app: string; // toolbox subheader within the Apps group — the app's name
    logoDomain: string; // favicon host, shared by every node of the platform
    actions: IntegrationAction[];
    events: ExtensionEvent[];
};

// a flat integration node = an action merged with its platform's app + logo,
// the shape lib/workflow.ts and src-tauri/src/integrations.rs consume.
type IntegrationProvider = IntegrationAction & {
    app: string; // toolbox subheader within the Apps group — the app's name
    logoDomain: string; // favicon host
};

// a flat event node = an ExtensionEvent merged with its platform's app + logo.
type ExtensionEventNode = ExtensionEvent & {
    platform: string; // owning PlatformExtension.id — the ingress routes transports by this
    app: string;
    logoDomain: string;
};

const EXTENSIONS: PlatformExtension[] = [
    {
        id: "discord",
        app: "discord",
        logoDomain: "discord.com",
        actions: [
            {
                id: "discord-webhook",
                label: "send webhook",
                section: "data",
                config: [
                    {
                        id: "webhookUrl", label: "webhook url", input: "text",
                        placeholder: "https://discord.com/api/webhooks/…",
                    },
                    { id: "message", label: "message", input: "text" },
                ],
                requiredConfig: ["webhookUrl"],
            },
            {
                id: "discord-send-message",
                label: "send message",
                section: "data",
                config: [
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "your bot's token",
                    },
                    {
                        id: "channelId", label: "channel id", input: "text",
                        placeholder: "channel to post in",
                    },
                    { id: "message", label: "message", input: "text" },
                ],
                requiredConfig: ["botToken", "channelId"],
            },
            {
                id: "discord-read-messages",
                label: "read messages",
                section: "data",
                config: [
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "your bot's token",
                    },
                    {
                        id: "channelId", label: "channel id", input: "text",
                        placeholder: "channel to read from",
                    },
                    { id: "count", label: "how many", input: "number", default: "20" },
                ],
                requiredConfig: ["botToken", "channelId"],
                output: { id: "messages", label: "messages" },
            },
            {
                id: "discord-typing",
                label: "typing status",
                section: "data",
                config: [
                    {
                        id: "status", label: "typing", input: "select",
                        options: ["on", "off"], default: "on",
                    },
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "your bot's token",
                    },
                    {
                        id: "channelId", label: "channel id", input: "text",
                        placeholder: "channel to type in",
                    },
                ],
                requiredConfig: ["botToken", "channelId"],
            },
        ],
        events: [
            {
                id: "discord-mentioned",
                label: "was mentioned",
                emoji: "💬",
                config: [
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "your bot's token",
                    },
                    {
                        id: "guildId", label: "server id (optional)", input: "text",
                        placeholder: "filter to one server",
                    },
                    {
                        id: "channelId", label: "channel id (optional)", input: "text",
                        placeholder: "filter to one channel",
                    },
                ],
                requiredConfig: ["botToken"],
            },
        ],
    },
    {
        id: "telegram",
        app: "telegram",
        logoDomain: "telegram.org",
        actions: [
            {
                id: "telegram-send-message",
                label: "send message",
                section: "data",
                config: [
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "from @BotFather",
                    },
                    {
                        id: "chatId", label: "chat id", input: "text",
                        placeholder: "chat to post in",
                    },
                    { id: "message", label: "message", input: "text" },
                ],
                requiredConfig: ["botToken", "chatId"],
            },
            {
                id: "telegram-typing",
                label: "typing status",
                section: "data",
                config: [
                    {
                        id: "status", label: "typing", input: "select",
                        options: ["on", "off"], default: "on",
                    },
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "from @BotFather",
                    },
                    {
                        id: "chatId", label: "chat id", input: "text",
                        placeholder: "chat to type in",
                    },
                ],
                requiredConfig: ["botToken", "chatId"],
            },
        ],
        events: [
            {
                id: "telegram-message",
                label: "got a message",
                emoji: "✈️",
                config: [
                    {
                        id: "botToken", label: "bot token", input: "text",
                        placeholder: "from @BotFather",
                    },
                    {
                        id: "chatId", label: "chat id (optional)", input: "text",
                        placeholder: "filter to one chat",
                    },
                ],
                requiredConfig: ["botToken"],
            },
        ],
    },
    {
        id: "github",
        app: "github",
        logoDomain: "github.com",
        // first events-only platform — no outbound actions yet
        actions: [],
        events: [
            {
                id: "github-push",
                label: "code pushed",
                emoji: "⬆️",
                config: [
                    {
                        id: "repo", label: "repository", input: "text",
                        placeholder: "owner/repo",
                    },
                    {
                        id: "branch", label: "branch (optional)", input: "text",
                        placeholder: "filter to one branch",
                    },
                ],
                requiredConfig: ["repo"],
            },
            {
                id: "github-issue",
                label: "issue opened",
                emoji: "🐛",
                config: [
                    {
                        id: "repo", label: "repository", input: "text",
                        placeholder: "owner/repo",
                    },
                ],
                requiredConfig: ["repo"],
            },
            {
                id: "github-pr",
                label: "pull request opened",
                emoji: "🔀",
                config: [
                    {
                        id: "repo", label: "repository", input: "text",
                        placeholder: "owner/repo",
                    },
                ],
                requiredConfig: ["repo"],
            },
            {
                id: "github-release",
                label: "release published",
                emoji: "🏷️",
                config: [
                    {
                        id: "repo", label: "repository", input: "text",
                        placeholder: "owner/repo",
                    },
                ],
                requiredConfig: ["repo"],
            },
            {
                id: "github-star",
                label: "got a star",
                emoji: "⭐",
                config: [
                    {
                        id: "repo", label: "repository", input: "text",
                        placeholder: "owner/repo",
                    },
                ],
                requiredConfig: ["repo"],
            },
        ],
    },
    {
        id: "webhook",
        app: "webhook",
        logoDomain: "",
        // generic inbound trigger: any external service POSTs a per-workflow URL
        // (provisioned in the designer, not config), so the event has no config
        actions: [],
        events: [
            {
                id: "webhook",
                label: "webhook received",
                emoji: "🪝",
                config: [],
                requiredConfig: [],
                // the deleted route embedded the JSON request body parsed, so a
                // single extract could reach body.user.id. Nothing builds this
                // payload any more — a desktop app has no ingress for it — so a
                // test run hands the node "" rather than a sample.
            },
        ],
    },
    {
        id: "http",
        app: "http",
        logoDomain: "",
        // generic outbound request: call any REST API without a per-app sender
        actions: [
            {
                id: "http-request",
                label: "http request",
                section: "data",
                config: [
                    {
                        id: "method", label: "method", input: "select",
                        options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET",
                    },
                    {
                        id: "url", label: "url", input: "text",
                        placeholder: "https://api.example.com/…",
                    },
                    {
                        id: "headers", label: "headers (json)", input: "textarea",
                        placeholder: '{"authorization": "Bearer …"}',
                    },
                    {
                        id: "body", label: "body", input: "textarea",
                        placeholder: "request body (ignored for GET)",
                    },
                ],
                requiredConfig: ["url"],
                output: { id: "response", label: "response" },
            },
        ],
        events: [],
    },
];

export const integrationKey = (id: string) => `${INTEGRATION_PREFIX}${id}`;
export const integrationProviderId = (type: string) => type.slice(INTEGRATION_PREFIX.length);
export const eventNodeKey = (id: string) => `${EVENT_PREFIX}${id}`;

// Flat, call-site-friendly views over EXTENSIONS. INTEGRATIONS/INTEGRATIONS_BY_ID
// stay identical to the pre-extensions exports (action id "discord-webhook"
// unchanged), so every existing consumer compiles untouched.
export const INTEGRATIONS: IntegrationProvider[] = EXTENSIONS.flatMap((ext) =>
    ext.actions.map((action) => ({ ...action, app: ext.app, logoDomain: ext.logoDomain })),
);

export const INTEGRATIONS_BY_ID: Record<string, IntegrationProvider> = Object.fromEntries(
    INTEGRATIONS.map((p) => [p.id, p]),
);

export const EXTENSION_EVENTS: ExtensionEventNode[] = EXTENSIONS.flatMap((ext) =>
    ext.events.map((event) => ({
        ...event,
        platform: ext.id,
        app: ext.app,
        logoDomain: ext.logoDomain,
    })),
);

// keyed by full node type (eventNodeKey(id) = "event:discord-mentioned"), the
// string a WorkflowNode.type carries — validation and the ingress look up here.
export const EXTENSION_EVENTS_BY_KEY: Record<string, ExtensionEventNode> = Object.fromEntries(
    EXTENSION_EVENTS.map((e) => [eventNodeKey(e.id), e]),
);
