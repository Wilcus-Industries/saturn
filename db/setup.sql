-- App-owned tables. better-auth owns user/session/subscription (managed via
-- lib/auth.ts) — do not add those here. Idempotent; run manually:
--   psql "$DATABASE_URL" -f db/setup.sql

-- pgvector backs memory_item embeddings; must come first so the vector type
-- exists before any table references it. Fails loudly on a DB without pgvector.
create extension if not exists vector;

create table if not exists workflow (
    id          uuid primary key default gen_random_uuid(),
    user_id     text not null references "user"(id) on delete cascade,
    name        text not null,
    emoji       text not null default '⚙️',
    description text not null default '',
    cron        text,  -- vestigial: the schedule now lives in a "schedule" event node's config.cron
    graph       jsonb not null default '{"nodes":[],"edges":[]}',
    active      boolean not null default true, -- gates scheduled runs only; manual runs ignore it
    last_run_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists workflow_user_id_idx on workflow (user_id);
-- added after initial rollout; keeps existing tables in sync with the create above
alter table workflow add column if not exists last_run_at timestamptz;
alter table workflow add column if not exists active boolean not null default true;
-- schedule moved into the graph's "schedule" event node; the column is now unused
alter table workflow alter column cron drop not null;

-- execution history for scheduled/test runs; retention capped in code (lib/runner.server.ts)
create table if not exists workflow_run (
    id          uuid primary key default gen_random_uuid(),
    workflow_id uuid not null references workflow(id) on delete cascade,
    trigger     text not null default 'cron' check (trigger in ('cron', 'manual', 'event')),
    status      text not null default 'running' check (status in ('running', 'success', 'error')),
    error       text not null default '',
    log         jsonb not null default '[]',   -- ConsoleLine[] {kind,text}, capped in code
    started_at  timestamptz not null default now(),
    finished_at timestamptz
);
create index if not exists workflow_run_workflow_started_idx
    on workflow_run (workflow_id, started_at desc);
-- added after initial rollout; keeps existing tables in sync with the create above
-- ('event' = real-time inbound event run, lib/events.server.ts ingestEvent)
alter table workflow_run drop constraint if exists workflow_run_trigger_check;
alter table workflow_run add constraint workflow_run_trigger_check
    check (trigger in ('cron', 'manual', 'event'));

-- user-registered MCP servers and skills (settings → workflow designer nodes)
create table if not exists registry_entry (
    id          uuid primary key default gen_random_uuid(),
    user_id     text not null references "user"(id) on delete cascade,
    kind        text not null check (kind in ('mcp', 'skill', 'memory', 'variable', 'sandbox')),
    name        text not null,
    emoji       text not null default '',        -- skill only
    description text not null default '',        -- skill only
    server_url  text not null default '',        -- mcp only
    auth_token  text not null default '',        -- mcp secret / variable value; write-only when secret, never sent to client
    secret      boolean not null default true,   -- variable only; true = write-only/never revealed, false = viewable/editable
    tools       jsonb not null default '[]',     -- mcp allowlist: [{name, access: "read"|"write", enabled}]
    oauth       jsonb not null default '{}',     -- mcp only; oauth client + tokens, server-only
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists registry_entry_user_id_idx on registry_entry (user_id);
-- added after initial rollout; keeps existing tables in sync with the create above
alter table registry_entry add column if not exists oauth jsonb not null default '{}';
-- default true keeps existing variable rows (all secrets) write-only after rollout
alter table registry_entry add column if not exists secret boolean not null default true;
-- ('memory' = a persistent agent-memory store; its items live in memory_item)
-- ('variable' = a named user variable; value lives in auth_token. secret=true →
--  write-only/never revealed; secret=false → viewable/editable plaintext)
-- ('sandbox' = a persistent per-user linux sandbox; its runtime state lives in
--  podman as a container/volume named from the entry uuid — no child table)
alter table registry_entry drop constraint if exists registry_entry_kind_check;
alter table registry_entry add constraint registry_entry_kind_check
    check (kind in ('mcp', 'skill', 'memory', 'variable', 'sandbox'));

-- items held by a memory store (registry_entry of kind 'memory'). Embeddings
-- are pgvector; agents search them semantically (cosine distance). Per-store
-- cap of 2000 rows is enforced in code, so an exact scan needs no ANN index.
create table if not exists memory_item (
    id         uuid primary key default gen_random_uuid(),
    entry_id   uuid not null references registry_entry(id) on delete cascade,
    user_id    text not null references "user"(id) on delete cascade,
    content    text not null,
    embedding  vector(1536),
    created_at timestamptz not null default now()
);
create index if not exists memory_item_entry_id_idx on memory_item (entry_id);

-- per-user secrets (settings → models). openrouter_key is the BYOK fallback
-- used when a user has no built-in credits (free tier / allowance exhausted).
-- Write-only, never sent to the client.
create table if not exists user_secret (
    user_id        text primary key references "user"(id) on delete cascade,
    openrouter_key text not null default '',
    updated_at     timestamptz not null default now()
);

-- built-in model credits usage ledger (source of truth — no balance column,
-- no reset job). One row per platform-billed LLM turn; the current
-- billing-period sum vs the tier allowance decides whether the platform key
-- may be used (lib/credits.server.ts). credits = ceil(cost_usd * 1000)
-- computed at insert (1,000 credits = $1); cost_microdollars keeps the raw
-- OpenRouter usage.cost * 1e6 for audit.
create table if not exists model_usage (
    id                uuid primary key default gen_random_uuid(),
    user_id           text not null references "user"(id) on delete cascade,
    model             text not null,
    credits           integer not null check (credits >= 0),
    cost_microdollars bigint not null default 0,
    prompt_tokens     integer not null default 0,
    completion_tokens integer not null default 0,
    source            text not null check (source in ('designer', 'cron', 'manual', 'event')),
    created_at        timestamptz not null default now()
);
create index if not exists model_usage_user_created_idx
    on model_usage (user_id, created_at desc);
-- added after initial rollout; keeps existing tables in sync with the create above
-- ('event' = usage from a real-time event-triggered run, lib/events.server.ts)
alter table model_usage drop constraint if exists model_usage_source_check;
alter table model_usage add constraint model_usage_source_check
    check (source in ('designer', 'cron', 'manual', 'event'));

-- central GitHub App installation → Saturn user mapping. One row per GitHub App
-- installation the user links via the OAuth-verified setup flow; the webhook
-- path (lib/githubApp.server.ts) looks it up by installation_id to gate
-- private-repo deliveries to the installing user. Uninstall webhook deletes the
-- row. account_login is the installation account (org/user) shown in settings.
create table if not exists github_installation (
    installation_id bigint primary key,
    user_id         text not null references "user"(id) on delete cascade,
    account_login   text not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists github_installation_user_id_idx on github_installation (user_id);
