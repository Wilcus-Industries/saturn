-- App-owned tables. better-auth owns user/session/subscription (managed via
-- lib/auth.ts) — do not add those here. Idempotent; run manually:
--   psql "$DATABASE_URL" -f db/setup.sql

create table if not exists workflow (
    id          uuid primary key default gen_random_uuid(),
    user_id     text not null references "user"(id) on delete cascade,
    name        text not null,
    emoji       text not null default '⚙️',
    description text not null default '',
    cron        text not null,
    graph       jsonb not null default '{"nodes":[],"edges":[]}',
    last_run_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists workflow_user_id_idx on workflow (user_id);
-- added after initial rollout; keeps existing tables in sync with the create above
alter table workflow add column if not exists last_run_at timestamptz;

-- execution history for scheduled/test runs; retention capped in code (lib/runner.server.ts)
create table if not exists workflow_run (
    id          uuid primary key default gen_random_uuid(),
    workflow_id uuid not null references workflow(id) on delete cascade,
    trigger     text not null default 'cron' check (trigger in ('cron', 'manual')),
    status      text not null default 'running' check (status in ('running', 'success', 'error')),
    error       text not null default '',
    log         jsonb not null default '[]',   -- ConsoleLine[] {kind,text}, capped in code
    started_at  timestamptz not null default now(),
    finished_at timestamptz
);
create index if not exists workflow_run_workflow_started_idx
    on workflow_run (workflow_id, started_at desc);

-- user-registered MCP servers and skills (settings → workflow designer nodes)
create table if not exists registry_entry (
    id          uuid primary key default gen_random_uuid(),
    user_id     text not null references "user"(id) on delete cascade,
    kind        text not null check (kind in ('mcp', 'skill')),
    name        text not null,
    emoji       text not null default '',        -- skill only
    description text not null default '',        -- skill only
    server_url  text not null default '',        -- mcp only
    auth_token  text not null default '',        -- mcp only; write-only, never sent to client
    tools       jsonb not null default '[]',     -- mcp allowlist: [{name, access: "read"|"write", enabled}]
    oauth       jsonb not null default '{}',     -- mcp only; oauth client + tokens, server-only
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists registry_entry_user_id_idx on registry_entry (user_id);
-- added after initial rollout; keeps existing tables in sync with the create above
alter table registry_entry add column if not exists oauth jsonb not null default '{}';

-- per-user secrets (settings → models). TEMPORARY: openrouter_key is a
-- stopgap until the built-in token system lands. Write-only, never sent
-- to the client.
create table if not exists user_secret (
    user_id        text primary key references "user"(id) on delete cascade,
    openrouter_key text not null default '',
    updated_at     timestamptz not null default now()
);
