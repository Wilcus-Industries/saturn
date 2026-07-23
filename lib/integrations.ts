// Platform extensions (client-safe). Each PlatformExtension bundles one app's
// outbound `actions` (message nodes → lib/integrations.server.ts senders) and
// inbound `events` (trigger nodes, delivered by the in-process gateway,
// lib/gateway.server.ts). Adding a platform = one descriptor
// here plus its senders/handlers server-side; interpreter/designer/toolbox
// derive everything from the flat views at the bottom.
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
export type IntegrationSection = (typeof INTEGRATION_SECTIONS)[number];

// one outbound message node type. app/logoDomain live on the owning
// PlatformExtension and get merged back into the flat INTEGRATIONS view.
export type IntegrationAction = {
    id: string; // key suffix: "discord-webhook"
    label: string;
    section: IntegrationSection; // the Blocks category this node's color comes from
    config: ConfigField[];
    // blank config fields validateGraphStrict warns about
    requiredConfig: string[];
    // single value output port for read-style actions (e.g. fetched messages
    // as a JSON string); the interpreter stashes the sender's result under it
    output?: { id: string; label: string };
};

// one inbound trigger node type. Its node key is eventNodeKey(id) and its
// catalog category is "events", so it renders/behaves like the schedule node,
// but delivery is real-time (no cron). samplePayload feeds designer test runs
// and the extract path picker; payloadDoc is the one-line shape for GRAPH_DOCS.
export type ExtensionEvent = {
    id: string; // key suffix: "discord-mentioned"
    label: string;
    emoji?: string; // fallback node icon when logoDomain has no favicon
    config: ConfigField[];
    // blank config fields validateGraphStrict warns about
    requiredConfig: string[];
    samplePayload: Record<string, unknown>; // canned payload for test runs
    payloadDoc: string; // one-line payload shape doc for GRAPH_DOCS
};

// one platform (an app) grouping its actions + events. app + logoDomain are
// shared by every node of the platform and merged into the flat views.
export type PlatformExtension = {
    id: string; // platform id, e.g. "discord"
    app: string; // toolbox subheader within the Apps group — the app's name
    logoDomain: string; // favicon host, shared by every node of the platform
    actions: IntegrationAction[];
    events: ExtensionEvent[];
};

// a flat integration node = an action merged with its platform's app + logo,
// the shape lib/workflow.ts and lib/integrations.server.ts consume.
export type IntegrationProvider = IntegrationAction & {
    app: string; // toolbox subheader within the Apps group — the app's name
    logoDomain: string; // favicon host
};

// a flat event node = an ExtensionEvent merged with its platform's app + logo.
export type ExtensionEventNode = ExtensionEvent & {
    platform: string; // owning PlatformExtension.id — the ingress routes transports by this
    app: string;
    logoDomain: string;
};

export const EXTENSIONS: PlatformExtension[] = [
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
                samplePayload: {
                    content: "hey @saturn, summarize today's thread",
                    authorId: "111111111111111111",
                    authorUsername: "ada",
                    channelId: "222222222222222222",
                    guildId: "333333333333333333",
                    messageId: "444444444444444444",
                    timestamp: "2026-07-18T12:34:56.000Z",
                },
                payloadDoc:
                    "{content, authorId, authorUsername, channelId, guildId, messageId, timestamp}",
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
                samplePayload: {
                    text: "hey saturn, what's the weather tomorrow?",
                    chatId: "123456789",
                    chatType: "private",
                    userId: "123456789",
                    username: "ada",
                    firstName: "Ada",
                    messageId: "42",
                    date: "2026-07-18T12:34:56.000Z",
                },
                payloadDoc:
                    "{text, chatId, chatType, userId, username, firstName, messageId, date}",
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
                    {
                        id: "botToken", label: "access token (optional)", input: "text",
                        placeholder: "github token — private repos / higher limits",
                    },
                ],
                requiredConfig: ["repo"],
                samplePayload: {
                    repo: "octocat/hello-world",
                    ref: "refs/heads/main",
                    branch: "main",
                    pusher: "ada",
                    commitCount: "3",
                    headSha: "0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09",
                    beforeSha: "9b1d3f7e6a5c4d3b2a1f0e9d8c7b6a5f4e3d2c1b",
                    messages: [
                        "fix: handle empty input",
                        "docs: update readme",
                        "feat: add retry",
                    ],
                    compareUrl:
                        "https://github.com/octocat/hello-world/compare/9b1d3f7e6a5c...0f7a2c9e5c8d",
                    timestamp: "2026-07-18T12:34:56Z",
                },
                payloadDoc:
                    "{repo, ref, branch, pusher, commitCount, headSha, beforeSha, messages, compareUrl, timestamp}",
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
                    {
                        id: "botToken", label: "access token (optional)", input: "text",
                        placeholder: "github token — private repos / higher limits",
                    },
                ],
                requiredConfig: ["repo"],
                samplePayload: {
                    repo: "octocat/hello-world",
                    number: "17",
                    title: "Crash when input is empty",
                    body: "Steps to reproduce: run with no arguments…",
                    author: "ada",
                    labels: ["bug"],
                    url: "https://github.com/octocat/hello-world/issues/17",
                    timestamp: "2026-07-18T12:34:56Z",
                },
                payloadDoc: "{repo, number, title, body, author, labels, url, timestamp}",
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
                    {
                        id: "botToken", label: "access token (optional)", input: "text",
                        placeholder: "github token — private repos / higher limits",
                    },
                ],
                requiredConfig: ["repo"],
                samplePayload: {
                    repo: "octocat/hello-world",
                    number: "42",
                    title: "Add retry logic to the fetcher",
                    body: "Retries transient failures up to 3 times.",
                    author: "ada",
                    sourceBranch: "feature/retries",
                    targetBranch: "main",
                    draft: "false",
                    url: "https://github.com/octocat/hello-world/pull/42",
                    timestamp: "2026-07-18T12:34:56Z",
                },
                payloadDoc:
                    "{repo, number, title, body, author, sourceBranch, targetBranch, draft, url, timestamp}",
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
                    {
                        id: "botToken", label: "access token (optional)", input: "text",
                        placeholder: "github token — private repos / higher limits",
                    },
                ],
                requiredConfig: ["repo"],
                samplePayload: {
                    repo: "octocat/hello-world",
                    tag: "v1.2.0",
                    name: "1.2.0",
                    body: "Highlights: retry logic, faster startup.",
                    author: "ada",
                    prerelease: "false",
                    url: "https://github.com/octocat/hello-world/releases/tag/v1.2.0",
                    timestamp: "2026-07-18T12:34:56Z",
                },
                payloadDoc: "{repo, tag, name, body, author, prerelease, url, timestamp}",
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
                    {
                        id: "botToken", label: "access token (optional)", input: "text",
                        placeholder: "github token — private repos / higher limits",
                    },
                ],
                requiredConfig: ["repo"],
                samplePayload: {
                    repo: "octocat/hello-world",
                    user: "ada",
                    timestamp: "2026-07-18T12:34:56Z",
                },
                payloadDoc: "{repo, user, timestamp}",
            },
        ],
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

// canned JSON payload string for a test run of an event node (nodeType =
// eventNodeKey(id)); "" for unknown types. runWorkflow's eventPayloads maps
// nodeId → this JSON string.
export const sampleEventPayload = (nodeType: string): string => {
    const event = EXTENSION_EVENTS_BY_KEY[nodeType];
    return event ? JSON.stringify(event.samplePayload) : "";
};
