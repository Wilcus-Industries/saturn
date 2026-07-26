//! Port of lib/registry.server.ts plus the server half of lib/registry.ts: the
//! user's own node types — MCP servers, skills, memory stores, variables — and
//! the CRUD the settings/designer forms drive.
//!
//! Two shape changes carried over from the schema rewrite (`store.rs`):
//!
//! * The five sparse kind-specific Postgres columns (`server_url`, `tools`,
//!   `oauth`, `auth_token`, `secret`) collapsed into one `config` JSON blob, so
//!   a new registry kind needs no schema change.
//! * Secrets left the database entirely. `auth_token`, the `oauth` set and a
//!   *secret* variable's value are Keychain items (`secrets.rs`); the row keeps
//!   only what the UI is allowed to see.
//!
//! **The read path never returns a secret.** `getUserRegistry`'s SELECT excluded
//! `auth_token` and projected `(auth_token <> '')` instead; here the equivalent
//! is `has_token` / `connected`, computed from the Keychain but never carrying
//! anything out of it. The one deliberate exception is the same one the SQL had:
//! a *non-secret* variable's value is viewable by the user's own choice, so it
//! lives in `config` (never the Keychain) and is returned as `value`.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::interpreter::{CatalogEntry, CatalogTool, ConfigField, Port};
use crate::mcp::{DiscoveredTool, McpToolParam, TokenSet};
use crate::secrets::{self, Secret, Vault};
use crate::store::Store;

// --- caps (lib/registry.ts, lib/formActions.server.ts, the save actions) -----

/// Absolute per-kind backstop. In the hosted product this sat under a plan
/// limit; the plan limits are gone with the subscription, so this is the only
/// cap left — it still exists to keep a runaway MCP client from filling the
/// registry with junk entries.
pub const MAX_ENTRIES_PER_KIND: i64 = 50;
/// Discovery returns whatever the server lists; the stored allowlist is capped
/// so one chatty server cannot make every catalog read expensive.
pub const MAX_MCP_TOOLS: usize = 40;
/// Names are rendered on a node box — 60 chars is what the designer lays out.
pub const MAX_NAME: usize = 60;
/// A skill's instructions / a memory store's note. Skill text is injected into
/// the agent's system prompt, so this is also a prompt-budget cap.
pub const MAX_DESCRIPTION: usize = 2000;
/// Bearer tokens and variable values. Long enough for a JWT, short enough that
/// a paste accident is not stored.
pub const MAX_TOKEN: usize = 4096;

/// The `*` sentinel of the MCP server grant chip. Imported rather than restated
/// so the catalog key this file writes and the grant parser that reads it can
/// never drift apart.
use crate::agent::ALL_TOOLS;

// --- types ------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Mcp,
    Skill,
    Memory,
    Variable,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Mcp => "mcp",
            Kind::Skill => "skill",
            Kind::Memory => "memory",
            Kind::Variable => "variable",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "mcp" => Some(Kind::Mcp),
            "skill" => Some(Kind::Skill),
            "memory" => Some(Kind::Memory),
            "variable" => Some(Kind::Variable),
            _ => None,
        }
    }
}

/// A tool on an MCP entry's stored allowlist. `access` is the user's grant;
/// `read_only` is the server's own `readOnlyHint`, absent when the server sends
/// no annotations (most of them) or the tool was added by hand.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct McpTool {
    pub name: String,
    pub access: String, // "read" | "write"
    pub enabled: bool,
    #[serde(rename = "readOnly", default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    /// discovered — display-only in settings, and fed to the model as the tool
    /// description when the agent gets the grant
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// discovered arg spec; absent for manually added tools
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<McpToolParam>>,
}

/// The OAuth set for one MCP entry — the whole `oauth` jsonb column, now a
/// single Keychain item. Every field is optional: `{}` until the flow starts.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpOauth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// epoch ms
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// pending authorization, set when the user is redirected out
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
}

/// The `config` blob. One struct for every kind — which fields are meaningful is
/// decided by `kind`, exactly as the sparse Postgres columns were. Absent fields
/// are skipped on write so a skill's config stays `{}`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Config {
    /// mcp
    #[serde(rename = "serverUrl", default, skip_serializing_if = "String::is_empty")]
    server_url: String,
    /// mcp — the stored tool allowlist (was the `tools` jsonb column)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tools: Vec<McpTool>,
    /// variable — write-only mode. Fixed at creation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    secret: bool,
    /// variable — the plaintext of a NON-secret variable only. A secret
    /// variable's value is a Keychain item and never appears here.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    value: String,
}

/// One registry row as the client is allowed to see it: the port of
/// `RegistryEntryRow`. `has_token` and `connected` are derived booleans — the
/// token and the OAuth set themselves are never selected, in Postgres or here.
#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub emoji: String,
    pub description: String,
    pub server_url: String,
    pub tools: Vec<McpTool>,
    /// derived — a manual bearer token is stored for this entry
    pub has_token: bool,
    /// derived — a usable OAuth access token is stored for this entry
    pub connected: bool,
    /// variable only — true = write-only, false = viewable/editable
    pub secret: bool,
    /// plaintext for regular (non-secret) variables only; "" otherwise
    pub value: String,
}

/// One MCP entry WITH its credentials. Server-side only: nothing on this struct
/// may be returned to the client.
pub struct McpSecrets {
    pub id: String,
    pub server_url: String,
    pub auth_token: Option<String>,
    pub tools: Vec<McpTool>,
    pub oauth: McpOauth,
}

/// The token refresh, as a `fn` pointer so the merge-and-persist logic below can
/// be tested offline. Production always passes `refresh_via_mcp`; the seam
/// exists because that is the only thing in this file that touches the network.
pub type RefreshFn = fn(&McpOauth, &str) -> Result<TokenSet, String>;

/// The save-time URL guard, injected for the same reason (it resolves DNS).
/// Production always passes `url_guard`.
pub type UrlShapeCheck = fn(&str) -> Result<(), String>;

/// Production wiring for `RefreshFn`. Which stored field feeds which request
/// parameter is registry knowledge, so the adapter lives here rather than in the
/// MCP client.
pub fn refresh_via_mcp(oauth: &McpOauth, resource: &str) -> Result<TokenSet, String> {
    crate::mcp::refresh_tokens(&crate::mcp::RefreshArgs {
        token_url: oauth.token_url.as_deref().unwrap_or_default(),
        client_id: oauth.client_id.as_deref().unwrap_or_default(),
        client_secret: oauth.client_secret.as_deref(),
        refresh_token: oauth.refresh_token.as_deref().unwrap_or_default(),
        resource,
    })
}

/// Production wiring for `UrlShapeCheck` — `assertHttpsUrlShape`, the sync half
/// of the SSRF guard. A save must not block on DNS, and a host that does not
/// resolve right now must still be storable; the full resolve-time guard runs
/// again at every fetch in the MCP client regardless.
pub fn url_guard(raw: &str) -> Result<(), String> {
    crate::http::assert_https_url_shape(raw).map(|_| ())
}

// --- helpers ----------------------------------------------------------------

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Port of `UUID_RE` — the canonical uuid shape check shared by every
/// id-validating action and MCP tool. Anchored and case-insensitive, so a
/// hostile id (`../`, a second uuid, a uuid with trailing junk) is refused
/// before it can reach a query or a node type.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Node type for a non-MCP registry chip: `skill:<uuid>`, `memory:<uuid>`,
/// `variable:<uuid>`. MCP servers use their own three-part key (see
/// `build_user_catalog`).
pub fn user_node_key(kind: Kind, id: &str) -> String {
    format!("{}:{}", kind.as_str(), id)
}

/// Reverse of `variable_sentinel`: a config field holding exactly a sentinel
/// resolves to its uuid. Lets a value snap into an app/event config box with no
/// edge and no standalone node.
// NOT dead by accident: the only consumer of this reverse lookup is the
// designer's config box (app/dashboard/workflows/[id]/node.tsx), which stays
// TypeScript and calls lib/registry.ts's copy. Kept because it is part of the
// ported surface and pinned by a test — a delete candidate, not a gap.
#[allow(dead_code)]
pub fn variable_id_from_sentinel(value: &str) -> Option<&str> {
    value
        .strip_prefix("{{var:")
        .and_then(|rest| rest.strip_suffix("}}"))
        .filter(|id| is_uuid(id))
}

/// The call gate. Blocks only a *provable* capability/grant mismatch: the server
/// explicitly declares the tool write-capable while the user granted read-only.
/// Unknown capability (manual tools, and the many servers that send no
/// annotations) trusts the user's grant — blocking there adds no safety, it just
/// forces a pointless flip to read+write.
pub fn can_call_tool(tool: &McpTool) -> bool {
    tool.read_only != Some(false) || tool.access == "write"
}

/// UTF-16 length, because every cap ported here was written against JS
/// `String.length` — an emoji counts 2 there and must count 2 here.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn required_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || len16(name) > MAX_NAME {
        return Err("Name is required (max 60 chars)".into());
    }
    Ok(name.to_string())
}

/// `optionalId`: present + valid uuid → update, absent → insert.
fn optional_id(id: Option<&str>) -> Result<Option<String>, String> {
    match id.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(id) if is_uuid(id) => Ok(Some(id.to_string())),
        Some(_) => Err("Invalid id".into()),
    }
}

fn read_config(store: &Store, id: &str, kind: Kind) -> Result<Option<Config>, String> {
    let conn = store.conn();
    let raw: Option<String> = conn
        .query_row(
            "select config from registry_entry where id = ?1 and kind = ?2",
            params![id, kind.as_str()],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    // a config that will not parse is treated as empty rather than fatal — the
    // row still renders, exactly as a null jsonb column did
    Ok(raw.map(|raw| serde_json::from_str(&raw).unwrap_or_default()))
}

fn count_kind(store: &Store, kind: Kind) -> Result<i64, String> {
    store
        .conn()
        .query_row(
            "select count(*) from registry_entry where kind = ?1",
            [kind.as_str()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
}

fn assert_under_cap(store: &Store, kind: Kind) -> Result<(), String> {
    if count_kind(store, kind)? >= MAX_ENTRIES_PER_KIND {
        return Err(format!(
            "Limit of {MAX_ENTRIES_PER_KIND} {} entries reached",
            kind.as_str()
        ));
    }
    Ok(())
}

fn insert_entry(
    store: &Store,
    kind: Kind,
    name: &str,
    emoji: &str,
    description: &str,
    config: &Config,
) -> Result<String, String> {
    let id = uuid();
    let at = now();
    store
        .conn()
        .execute(
            "insert into registry_entry (id, kind, name, emoji, description, config, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                kind.as_str(),
                name,
                emoji,
                description,
                serde_json::to_string(config).map_err(|e| e.to_string())?,
                at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Every update goes through here so `updated_at` can never be forgotten, and so
/// the kind guard (a variable id must not be updatable through the skill form)
/// is applied in one place. `Err("Not found")` mirrors the `if (!rowCount)`
/// check every save action had.
fn update_entry(
    store: &Store,
    id: &str,
    kind: Kind,
    name: &str,
    emoji: Option<&str>,
    description: Option<&str>,
    config: Option<&Config>,
) -> Result<(), String> {
    let config = config
        .map(|c| serde_json::to_string(c))
        .transpose()
        .map_err(|e| e.to_string())?;
    let changed = store
        .conn()
        .execute(
            "update registry_entry
                set name = ?3,
                    emoji = coalesce(?4, emoji),
                    description = coalesce(?5, description),
                    config = coalesce(?6, config),
                    updated_at = ?7
              where id = ?1 and kind = ?2",
            params![id, kind.as_str(), name, emoji, description, config, now()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Not found".into());
    }
    Ok(())
}

// --- read paths -------------------------------------------------------------

/// Port of `getUserRegistry`, minus the userId and minus the TTL cache (the
/// cache existed to keep a multi-tenant web request off Postgres; this is one
/// process reading a local file).
///
/// The Keychain is consulted only to derive two booleans. Nothing it returns
/// leaves this function.
pub fn get_user_registry(store: &Store, vault: &dyn Vault) -> Result<Vec<Entry>, String> {
    // read the rows and drop the connection guard BEFORE touching the Keychain:
    // the guard serializes every reader in the process, and a Keychain round
    // trip under it would stall the scheduler.
    let rows: Vec<(String, String, String, String, String, String)> = {
        let conn = store.conn();
        let mut stmt = conn
            // `, id` is not in the SQL original: created_at is epoch *millis*
            // here where Postgres had microseconds, so same-millisecond ties are
            // actually reachable and would otherwise order arbitrarily.
            .prepare(
                "select id, kind, name, emoji, description, config
                   from registry_entry order by created_at, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    Ok(rows
        .into_iter()
        .map(|(id, kind, name, emoji, description, raw)| {
            let config: Config = serde_json::from_str(&raw).unwrap_or_default();
            let is_variable = kind == Kind::Variable.as_str();
            Entry {
                // `(auth_token <> '')`. One SQL column held three different
                // things, so one probe answered for every kind; here they live
                // in three different places and the probe has to follow the
                // kind. Getting this wrong is not cosmetic: `has_token` is the
                // ONLY signal the variable modal has that a secret value is
                // stored, and it gates the "clear stored value" checkbox.
                has_token: match (is_variable, config.secret) {
                    (true, true) => secrets::has(vault, &Secret::Variable(&id)),
                    (true, false) => !config.value.is_empty(),
                    (false, _) => secrets::has(vault, &Secret::McpToken(&id)),
                },
                // `(oauth->>'accessToken' <> '')`: presence of the OAuth item is
                // NOT enough — the pending set written before the redirect has
                // no access token yet and must not read as connected.
                connected: secrets::get(vault, &Secret::McpOauth(&id))
                    .and_then(|raw| serde_json::from_str::<McpOauth>(&raw).ok())
                    .and_then(|o| o.access_token)
                    .is_some_and(|t| !t.is_empty()),
                // the SQL's `case when kind = 'variable' and not secret` — a
                // secret variable's value is never projected here
                value: if is_variable && !config.secret {
                    config.value.clone()
                } else {
                    String::new()
                },
                secret: is_variable && config.secret,
                server_url: config.server_url,
                tools: config.tools,
                id,
                kind,
                name,
                emoji,
                description,
            }
        })
        .collect())
}

/// Port of `getMcpSecrets`. Server-side MCP calls only — nothing on the returned
/// struct may be handed to the client.
pub fn mcp_secrets(
    store: &Store,
    vault: &dyn Vault,
    id: &str,
) -> Result<Option<McpSecrets>, String> {
    if !is_uuid(id) {
        return Ok(None);
    }
    let Some(config) = read_config(store, id, Kind::Mcp)? else {
        return Ok(None);
    };
    Ok(Some(McpSecrets {
        auth_token: secrets::get(vault, &Secret::McpToken(id)),
        oauth: secrets::get(vault, &Secret::McpOauth(id))
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        server_url: config.server_url,
        tools: config.tools,
        id: id.to_string(),
    }))
}

/// Bearer token for a server-side MCP call: a manual token wins, otherwise the
/// stored OAuth access token, refreshed and persisted when expired. Returns the
/// OAuth set as stored *after* any refresh so a caller never holds a rotated-away
/// refresh token.
pub fn fresh_mcp_token(
    store: &Store,
    vault: &dyn Vault,
    entry: &McpSecrets,
) -> Result<(Option<String>, McpOauth), String> {
    fresh_mcp_token_with(store, vault, entry, refresh_via_mcp)
}

/// `fresh_mcp_token` with the refresh call injected — tests only.
pub fn fresh_mcp_token_with(
    store: &Store,
    vault: &dyn Vault,
    entry: &McpSecrets,
    refresh: RefreshFn,
) -> Result<(Option<String>, McpOauth), String> {
    let mut oauth = entry.oauth.clone();
    if let Some(token) = entry.auth_token.clone() {
        return Ok((Some(token), oauth));
    }

    let refreshable = oauth.access_token.is_some()
        && oauth.token_url.is_some()
        && oauth.client_id.is_some()
        && oauth.refresh_token.is_some()
        && oauth.expires_at.is_some_and(|exp| exp < now());
    if refreshable {
        let fresh = refresh(&oauth, &entry.server_url)?;
        oauth.access_token = Some(fresh.access_token);
        // a token endpoint that omits refresh_token leaves the old one in force;
        // one that rotates it must not leave the old one behind
        oauth.refresh_token = fresh.refresh_token.or(oauth.refresh_token);
        // NOT `.or(...)`: the TypeScript spread wrote `expiresAt: undefined`
        // when the response had no expires_in, which stops the next call from
        // refreshing at all (the token is then used until it 401s). Keeping a
        // stale expiry would refresh on every single call instead.
        oauth.expires_at = fresh.expires_at;
        write_mcp_oauth(store, vault, &entry.id, &oauth)?;
    }
    Ok((oauth.access_token.clone().filter(|t| !t.is_empty()), oauth))
}

/// One variable's plaintext. Secret variables come from the Keychain, regular
/// ones from the row — the same split `get_user_registry` reads.
pub fn variable_value(store: &Store, vault: &dyn Vault, id: &str) -> Option<String> {
    if !is_uuid(id) {
        return None;
    }
    let config = read_config(store, id, Kind::Variable).ok()??;
    if config.secret {
        secrets::get(vault, &Secret::Variable(id))
    } else {
        Some(config.value)
    }
}

/// The lookup `integrations::substitute_variables` takes. Plaintext resolution
/// happens ONLY at the point of consumption — this closure is the whole of the
/// substitution surface, and it is built per call site rather than parked in a
/// global so nothing can substitute a sentinel by accident.
pub fn variable_lookup<'a>(
    store: &'a Store,
    vault: &'a dyn Vault,
) -> impl Fn(&str) -> Option<String> + 'a {
    move |id| variable_value(store, vault, id)
}

// --- catalog ----------------------------------------------------------------

pub fn value_port(id: &str) -> Port {
    Port { id: id.to_string(), kind: "value".to_string(), multi: false, accepts: None }
}

fn chip(row: &Entry, kind: Kind, port: &str) -> CatalogEntry {
    CatalogEntry {
        key: user_node_key(kind, &row.id),
        category: kind.as_str().to_string(),
        label: row.name.clone(),
        inputs: Vec::new(),
        outputs: vec![value_port(port)],
        config: Vec::new(),
        required_config: Vec::new(),
        tools: Vec::new(),
        missing: false,
        tool_name: None,
    }
}

/// Port of `buildUserCatalog`, keyed by node type instead of returned as an
/// array — `byKey` is what every consumer built from it anyway, and the
/// interpreter's registry overlay is exactly this map.
///
/// The rendering-only fields the TypeScript entries carried (emoji,
/// `logoDomain`, a variable's `secret` colour split, the mcp chip's expansion
/// `tools` list for the designer's picker) are absent from the Rust
/// `CatalogEntry`, which is execution-shaped.
pub fn build_user_catalog(rows: &[Entry]) -> HashMap<String, CatalogEntry> {
    rows.iter()
        .filter_map(|row| {
            let entry = match Kind::parse(&row.kind)? {
                Kind::Skill => chip(row, Kind::Skill, "skill"),
                Kind::Memory => chip(row, Kind::Memory, "memory"),
                Kind::Variable => chip(row, Kind::Variable, "value"),
                // the MCP server grant chip: one non-executable chip per server,
                // keyed `mcp:<uuid>:*`. Wired into an agent's tools port it
                // grants every enabled + callable tool minus `config.exclude`.
                // Always emitted, even with zero enabled tools — disabling
                // everything in settings must not flip saved nodes to
                // "(deleted)".
                Kind::Mcp => CatalogEntry {
                    key: format!("mcp:{}:{ALL_TOOLS}", row.id),
                    category: "mcp".to_string(),
                    label: row.name.clone(),
                    inputs: Vec::new(),
                    outputs: vec![value_port("tool")],
                    config: vec![ConfigField { id: "exclude".to_string() }],
                    required_config: Vec::new(),
                    // exactly the runtime expansion set, so `validate_graph`
                    // warns about an excluded name the chip would never grant.
                    // Guard the sentinel: a real tool named "*" never grants.
                    tools: row
                        .tools
                        .iter()
                        .filter(|t| t.enabled && can_call_tool(t) && t.name != ALL_TOOLS)
                        .map(|t| CatalogTool { name: t.name.clone() })
                        .collect(),
                    missing: false,
                    tool_name: Some(ALL_TOOLS.to_string()),
                },
            };
            Some((entry.key.clone(), entry))
        })
        .collect()
}

// --- tool list --------------------------------------------------------------

/// Port of `parseTools` (the settings action). The client only ever submits
/// `{name, access, enabled}`; discovered metadata is re-attached from storage by
/// `save_mcp_server`.
pub fn parse_tools(raw: &str) -> Result<Vec<McpTool>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Invalid tools".to_string())?;
    let items = parsed.as_array().ok_or("Invalid tools")?;
    if items.len() > MAX_MCP_TOOLS {
        return Err("Invalid tools".into());
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let obj = item.as_object().ok_or("Invalid tools")?;
        // a missing or non-string name is the *name* error, not "Invalid tools"
        // — the TypeScript folded both into one `typeof name !== "string"` test
        let trimmed = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if trimmed.is_empty() || len16(trimmed) > MAX_NAME {
            return Err("Tool names must be 1-60 chars".into());
        }
        let access = obj.get("access").and_then(|v| v.as_str()).unwrap_or("");
        if access != "read" && access != "write" {
            return Err("Invalid tool access".into());
        }
        let enabled = obj.get("enabled").and_then(|v| v.as_bool()).ok_or("Invalid tools")?;
        if seen.iter().any(|s| s == trimmed) {
            return Err(format!("Duplicate tool name: {trimmed}"));
        }
        seen.push(trimmed.to_string());
        out.push(McpTool {
            name: trimmed.to_string(),
            access: access.to_string(),
            enabled,
            ..Default::default()
        });
    }
    Ok(out)
}

/// Port of `mergeTools`. Discovered tools REPLACE the stored allowlist; `access`
/// is the user's grant and survives, except that a read-only tool is capped at
/// "read" (a write grant there is meaningless). Newly seen read-only tools start
/// on, write-capable ones start off, unknown ones start off at read — least
/// privilege in every direction.
pub fn merge_tools(existing: &[McpTool], discovered: &[DiscoveredTool]) -> Vec<McpTool> {
    discovered
        .iter()
        .take(MAX_MCP_TOOLS)
        .map(|d| {
            let fresh_meta = |mut t: McpTool| {
                // freshly discovered metadata always overwrites what is stored —
                // including with None, which drops a stale annotation (the
                // TypeScript let `readOnly: undefined` land in the object for
                // exactly this, since serialization then omits the key)
                t.read_only = d.read_only;
                // an empty description is the JS falsy case: the spread skipped
                // it, so a stored one survives. An empty params array is truthy
                // there and does overwrite.
                if !d.description.is_empty() {
                    t.description = Some(d.description.clone());
                }
                t.params = Some(d.params.clone());
                t
            };
            match existing.iter().find(|t| t.name == d.name) {
                Some(kept) => {
                    let mut t = fresh_meta(kept.clone());
                    if d.read_only == Some(true) {
                        t.access = "read".to_string();
                    }
                    t
                }
                None => fresh_meta(McpTool {
                    name: d.name.clone(),
                    access: if d.read_only == Some(false) { "write" } else { "read" }.to_string(),
                    enabled: d.read_only == Some(true),
                    ..Default::default()
                }),
            }
        })
        .collect()
}

// --- writes -----------------------------------------------------------------

/// Port of `saveMcpServer`. Returns the entry id.
///
/// The URL guard keeps an internal address out of the registry at save time; the
/// full resolve-time SSRF guard still runs again at every fetch in the MCP
/// client, because a name that was public at save time can point elsewhere by
/// the time it is called.
#[allow(clippy::too_many_arguments)]
pub fn save_mcp_server(
    store: &Store,
    vault: &dyn Vault,
    id: Option<&str>,
    name: &str,
    server_url: &str,
    auth_token: &str,
    clear_token: bool,
    tools_json: &str,
) -> Result<String, String> {
    save_mcp_server_with(
        store, vault, id, name, server_url, auth_token, clear_token, tools_json, url_guard,
    )
}

/// `save_mcp_server` with the URL guard injected — tests only, so they can
/// exercise the save path without a name lookup.
#[allow(clippy::too_many_arguments)]
pub fn save_mcp_server_with(
    store: &Store,
    vault: &dyn Vault,
    id: Option<&str>,
    name: &str,
    server_url: &str,
    auth_token: &str,
    clear_token: bool,
    tools_json: &str,
    url_guard: UrlShapeCheck,
) -> Result<String, String> {
    let id = optional_id(id)?;
    let name = required_name(name)?;

    let server_url = server_url.trim();
    url_guard(server_url)?;

    let auth_token = auth_token.trim();
    if len16(auth_token) > MAX_TOKEN {
        return Err("Token too long".into());
    }

    let mut tools = parse_tools(tools_json)?;

    let entry_id = match id {
        Some(id) => {
            // parse_tools strips everything but {name, access, enabled} — the
            // client never submits discovered readOnly/description/params.
            // Re-attach the stored ones by tool name so a settings save does not
            // wipe them.
            let stored = read_config(store, &id, Kind::Mcp)?.ok_or("Not found")?.tools;
            for tool in &mut tools {
                if let Some(prev) = stored.iter().find(|p| p.name == tool.name) {
                    if prev.read_only.is_some() {
                        tool.read_only = prev.read_only;
                    }
                    if prev.description.is_some() {
                        tool.description = prev.description.clone();
                    }
                    if prev.params.is_some() {
                        tool.params = prev.params.clone();
                    }
                }
            }
            let config = Config {
                server_url: server_url.to_string(),
                tools,
                ..Default::default()
            };
            update_entry(store, &id, Kind::Mcp, &name, None, None, Some(&config))?;
            id
        }
        None => {
            assert_under_cap(store, Kind::Mcp)?;
            let config = Config {
                server_url: server_url.to_string(),
                tools,
                ..Default::default()
            };
            insert_entry(store, Kind::Mcp, &name, "", "", &config)?
        }
    };

    // the secret is written only after the row exists / was found, so a rejected
    // save never leaves a Keychain item with nothing pointing at it
    secrets::set(vault, &Secret::McpToken(&entry_id), Some(auth_token), clear_token)?;
    Ok(entry_id)
}

/// Port of `saveSkill` and `saveMemoryStore` — the two kinds that are nothing
/// but name + emoji + description, with no secret to place. A skill's
/// `description` is its instructions: injected verbatim into the agent's system
/// prompt by id, never by caller-supplied text. Memory stores have no per-store
/// item cap (uncapped stores were the point of the SQLite move).
///
/// The default emoji and the over-length message are properties of the kind, so
/// they are derived here rather than passed by every caller.
pub fn save_entry(
    store: &Store,
    kind: Kind,
    id: Option<&str>,
    name: &str,
    emoji: &str,
    description: &str,
) -> Result<String, String> {
    let (default_emoji, too_long) = match kind {
        Kind::Skill => ("⚙️", "Instructions too long"),
        Kind::Memory => ("🧠", "Note too long"),
        // mcp and variable carry config and a Keychain secret — they have their
        // own savers and must never take this path.
        Kind::Mcp | Kind::Variable => return Err("Unsupported kind".into()),
    };
    let id = optional_id(id)?;
    let name = required_name(name)?;
    let emoji = match emoji.trim() {
        "" => default_emoji,
        e => e,
    };
    let description = description.trim();
    if len16(description) > MAX_DESCRIPTION {
        return Err(too_long.into());
    }
    match id {
        Some(id) => {
            update_entry(store, &id, kind, &name, Some(emoji), Some(description), None)?;
            Ok(id)
        }
        None => {
            assert_under_cap(store, kind)?;
            insert_entry(store, kind, &name, emoji, description, &Config::default())
        }
    }
}

/// Port of `saveVariable`. Mode (`secret`) is fixed at creation: the edit
/// checkbox is disabled client-side, so the stored mode is read back here and
/// the submitted one is never trusted.
pub fn save_variable(
    store: &Store,
    vault: &dyn Vault,
    id: Option<&str>,
    name: &str,
    value: &str,
    clear_value: bool,
    secret: bool,
) -> Result<String, String> {
    let id = optional_id(id)?;
    let name = required_name(name)?;
    let value = value.trim();
    if len16(value) > MAX_TOKEN {
        return Err("Value too long".into());
    }

    match id {
        Some(id) => {
            let stored = read_config(store, &id, Kind::Variable)?.ok_or("Not found")?;
            let config = Config {
                secret: stored.secret,
                // regular variables: the submitted plaintext is authoritative,
                // blank included. Secret ones keep whatever the row held (which
                // is nothing — their value is a Keychain item).
                value: if stored.secret { String::new() } else { value.to_string() },
                ..stored.clone()
            };
            update_entry(store, &id, Kind::Variable, &name, None, None, Some(&config))?;
            if stored.secret {
                // write-only: blank keeps, clear erases, filled overwrites
                secrets::set(vault, &Secret::Variable(&id), Some(value), clear_value)?;
            }
            // AFTER the Keychain write, not before: a variable can be an event
            // node's bot token, and waking the transports while the old value is
            // still stored would just re-cache the old token for another minute.
            crate::events::subscriptions_changed();
            Ok(id)
        }
        None => {
            if value.is_empty() {
                return Err("Value is required".into());
            }
            if count_kind(store, Kind::Variable)? >= MAX_ENTRIES_PER_KIND {
                return Err(format!("Limit of {MAX_ENTRIES_PER_KIND} variables reached"));
            }
            let config = Config {
                secret,
                value: if secret { String::new() } else { value.to_string() },
                ..Default::default()
            };
            let id = insert_entry(store, Kind::Variable, &name, "", "", &config)?;
            if secret {
                secrets::set(vault, &Secret::Variable(&id), Some(value), false)?;
            }
            crate::events::subscriptions_changed();
            Ok(id)
        }
    }
}

/// Replaces an MCP entry's stored tool allowlist — the discovery path's write
/// (`update registry_entry set tools = ...`).
pub fn set_mcp_tools(store: &Store, id: &str, tools: Vec<McpTool>) -> Result<(), String> {
    let mut config = read_config(store, id, Kind::Mcp)?.ok_or("Not found")?;
    config.tools = tools;
    let name: String = store
        .conn()
        .query_row("select name from registry_entry where id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    update_entry(store, id, Kind::Mcp, &name, None, None, Some(&config))
}

/// Persists an MCP entry's OAuth set (the pending set before the redirect, the
/// exchanged set in the callback, the rotated set after a refresh). The whole
/// blob is one Keychain item: it carries the client secret, the access token,
/// the refresh token and the PKCE verifier, none of which may sit in the
/// database.
pub fn write_mcp_oauth(
    store: &Store,
    vault: &dyn Vault,
    id: &str,
    oauth: &McpOauth,
) -> Result<(), String> {
    let json = serde_json::to_string(oauth).map_err(|e| e.to_string())?;
    // The row goes FIRST, and no row means no write. `update ... where id` was
    // the TypeScript's existence check too, but there the token and the row were
    // the same statement; here a Keychain item written for a row that is already
    // gone is an orphan holding an access token, a refresh token and the client
    // secret, with nothing left to ever sweep it (`delete_entry` sweeps by id).
    // `updated_at` is also the settings list's sort key, which is why it moves.
    let changed = store
        .conn()
        .execute(
            "update registry_entry set updated_at = ?2 where id = ?1 and kind = 'mcp'",
            params![id, now()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Not found".into());
    }
    secrets::set(vault, &Secret::McpOauth(id), Some(&json), false)
}

/// Deletes one entry and everything that belongs to it. Returns whether a row
/// was actually removed (`deleteRegistryEntry` threw "Not found" on zero,
/// `deleteVariable` was idempotent — the caller picks).
///
/// The Keychain sweep and the memory-item sweep happen here, not at call sites:
/// an orphaned token is a leak, and orphaned vectors are a store's worth of the
/// user's data with nothing left to read it.
pub fn delete_entry(store: &Store, vault: &dyn Vault, id: &str) -> Result<bool, String> {
    // Before the shape check, and on the store method rather than the command:
    // the same reasoning `subscriptions_changed()` gets — no future IPC command
    // or Saturn tool can route around a guard that lives here.
    if id == crate::saturn::MEMORY_ID {
        return Err("Saturn's memory store cannot be deleted".into());
    }
    if !is_uuid(id) {
        return Err("Invalid id".into());
    }
    let removed = {
        let conn = store.conn();
        let removed = conn
            .execute("delete from registry_entry where id = ?1", [id])
            .map_err(|e| e.to_string())?;
        // memory_item is a vec0 virtual table, so there is no FK to cascade the
        // way the Postgres schema did — the sweep is manual and unconditional.
        conn.execute("delete from memory_item where entry_id = ?1", [id])
            .map_err(|e| e.to_string())?;
        removed
    };
    secrets::delete_entry_secrets(vault, id)?;
    // unconditional rather than kind-checked: a deleted *variable* unsubscribes
    // every event node that used it as a bot token, and re-reading the row to
    // learn the kind after deleting it is not possible. A spurious wake after an
    // MCP/skill/memory delete costs one feed scan.
    if removed > 0 {
        crate::events::subscriptions_changed();
    }
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::FakeVault;

    struct Tmp(std::path::PathBuf, Store);

    impl Tmp {
        fn new() -> Tmp {
            let dir = std::env::temp_dir().join(format!("saturn-registry-{}", uuid()));
            let store = Store::open(&dir.join("saturn.db")).unwrap();
            // Every database is seeded with Saturn Agent's own memory store
            // (store.rs's SCHEMA). Raw SQL rather than `delete_entry`, which
            // refuses it on purpose — these tests are about the *user's*
            // registry, and counting it into every assertion would only make
            // them read as arithmetic. That it exists, survives a reopen and
            // cannot be deleted is asserted in saturn.rs instead.
            store
                .conn()
                .execute("delete from registry_entry where id = ?1", [crate::saturn::MEMORY_ID])
                .unwrap();
            Tmp(dir, store)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn https_ok(_: &str) -> Result<(), String> {
        Ok(())
    }

    fn https_refuse(_: &str) -> Result<(), String> {
        Err("Server URL must be https".into())
    }

    fn only(rows: &[Entry], kind: &str) -> Entry {
        rows.iter().find(|r| r.kind == kind).expect("no row of that kind").clone()
    }

    /// CRUD for all four kinds plus the config round trip: what goes into the
    /// blob per kind must come back out as the same typed row.
    #[test]
    fn crud_round_trips_every_kind() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());

        let mcp = save_mcp_server_with(
            store,
            &vault,
            None,
            "Notion",
            "https://mcp.notion.com/mcp",
            "tok-123",
            false,
            r#"[{"name":"search","access":"read","enabled":true}]"#,
            https_ok,
        )
        .unwrap();
        let skill = save_entry(store, Kind::Skill, None, "Tone", "", "write tersely").unwrap();
        let memory = save_entry(store, Kind::Memory, None, "Notes", "", "long term").unwrap();
        let var = save_variable(store, &vault, None, "API key", "hunter2", false, true).unwrap();
        let plain = save_variable(store, &vault, None, "Region", "eu-west-1", false, false).unwrap();

        let rows = get_user_registry(store, &vault).unwrap();
        assert_eq!(rows.len(), 5);

        let m = only(&rows, "mcp");
        assert_eq!(m.id, mcp);
        assert_eq!(m.server_url, "https://mcp.notion.com/mcp");
        assert_eq!(m.tools, vec![McpTool {
            name: "search".into(),
            access: "read".into(),
            enabled: true,
            ..Default::default()
        }]);
        assert!(m.has_token, "the manual token must show as present");
        assert!(!m.connected, "no oauth set was written");

        let s = only(&rows, "skill");
        assert_eq!((s.id.as_str(), s.name.as_str(), s.emoji.as_str()), (skill.as_str(), "Tone", "⚙️"));
        assert_eq!(s.description, "write tersely");
        assert_eq!(only(&rows, "memory").emoji, "🧠");
        assert_eq!(only(&rows, "memory").id, memory);

        let secret_var = rows.iter().find(|r| r.id == var).unwrap();
        assert!(secret_var.secret);
        assert_eq!(secret_var.value, "", "a secret variable's value must never be projected");
        let plain_var = rows.iter().find(|r| r.id == plain).unwrap();
        assert!(!plain_var.secret);
        assert_eq!(plain_var.value, "eu-west-1", "a regular variable's value stays viewable");

        // ...and only the secret one is in the vault
        assert!(secrets::has(&vault, &Secret::Variable(&var)));
        assert!(!secrets::has(&vault, &Secret::Variable(&plain)));

        // updates keep ids and hit the right kind
        save_entry(store, Kind::Skill, Some(&skill), "Tone v2", "🎯", "still tersely").unwrap();
        let rows = get_user_registry(store, &vault).unwrap();
        assert_eq!(only(&rows, "skill").name, "Tone v2");
        assert_eq!(only(&rows, "skill").emoji, "🎯");
        // the kind guard: a skill id is not editable through the memory form
        assert_eq!(save_entry(store, Kind::Memory, Some(&skill), "x", "", ""), Err("Not found".into()));
    }

    /// The read path is the one place a secret could escape to the UI. It must
    /// report booleans and nothing else — including for an entry whose Keychain
    /// items all exist.
    #[test]
    fn the_read_path_never_carries_a_secret() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(
            store, &vault, None, "S", "https://s.test/mcp", "super-secret-token", false, "[]",
            https_ok,
        )
        .unwrap();
        write_mcp_oauth(
            store,
            &vault,
            &id,
            &McpOauth {
                access_token: Some("at-secret".into()),
                refresh_token: Some("rt-secret".into()),
                client_secret: Some("cs-secret".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let secret_var =
            save_variable(store, &vault, None, "k", "value-secret", false, true).unwrap();

        let rows = get_user_registry(store, &vault).unwrap();
        let json = serde_json::to_string(&rows).unwrap();
        for leaked in ["super-secret-token", "at-secret", "rt-secret", "cs-secret", "value-secret"] {
            assert!(!json.contains(leaked), "read path leaked {leaked}: {json}");
        }
        let m = rows.iter().find(|r| r.id == id).unwrap();
        assert!(m.has_token && m.connected);
        assert!(!rows.iter().find(|r| r.id == secret_var).unwrap().value.contains("value"));
    }

    /// A pending OAuth set (written before the user is redirected out) has no
    /// access token yet — `connected` must stay false, or settings claims the
    /// server is wired up when the flow never finished.
    #[test]
    fn a_pending_oauth_set_is_not_connected() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(store, &vault, None, "S", "https://s.test/mcp", "", false, "[]", https_ok)
            .unwrap();
        write_mcp_oauth(
            store,
            &vault,
            &id,
            &McpOauth {
                client_id: Some("cid".into()),
                state: Some("st".into()),
                code_verifier: Some("cv".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let rows = get_user_registry(store, &vault).unwrap();
        assert!(!rows[0].connected);
        assert!(!rows[0].has_token);
    }

    /// The write-only convention as the save action drives it, end to end: the
    /// second save leaves the token box empty (the only way a stored token is
    /// ever rendered) and must not erase it.
    #[test]
    fn a_blank_token_box_keeps_the_stored_token() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(
            store, &vault, None, "S", "https://s.test/mcp", "tok-original", false, "[]", https_ok,
        )
        .unwrap();

        save_mcp_server_with(
            store, &vault, Some(&id), "S renamed", "https://s.test/mcp", "", false, "[]", https_ok,
        )
        .unwrap();
        assert_eq!(
            secrets::get(&vault, &Secret::McpToken(&id)).as_deref(),
            Some("tok-original"),
            "an untouched token box must KEEP"
        );

        save_mcp_server_with(
            store, &vault, Some(&id), "S", "https://s.test/mcp", "ignored", true, "[]", https_ok,
        )
        .unwrap();
        assert!(!secrets::has(&vault, &Secret::McpToken(&id)), "the clear checkbox must erase");

        // same convention on a secret variable, where mode comes from storage
        let v = save_variable(store, &vault, None, "k", "v1", false, true).unwrap();
        save_variable(store, &vault, Some(&v), "k", "", false, false).unwrap();
        assert_eq!(variable_value(store, &vault, &v).as_deref(), Some("v1"), "blank must KEEP");
        // ...and the submitted `secret=false` must not have downgraded the mode
        let rows = get_user_registry(store, &vault).unwrap();
        let row = rows.iter().find(|r| r.id == v).unwrap();
        assert!(row.secret && row.value.is_empty(), "mode is fixed at creation");
        save_variable(store, &vault, Some(&v), "k", "", true, false).unwrap();
        assert_eq!(variable_value(store, &vault, &v), None);
    }

    /// `has_token` is the only thing telling the variable modal that a secret
    /// value is stored — it renders the "•••• value set" placeholder AND gates
    /// the "clear stored value" checkbox. Probing the mcp-token account for a
    /// variable answers false forever, which silently removes the only way to
    /// clear a secret variable short of deleting it.
    #[test]
    fn has_token_follows_the_kind() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let secret = save_variable(store, &vault, None, "k", "sk-live", false, true).unwrap();
        let plain = save_variable(store, &vault, None, "region", "eu", false, false).unwrap();
        let empty = save_variable(store, &vault, None, "blank", "x", false, false).unwrap();
        save_variable(store, &vault, Some(&empty), "blank", "", false, false).unwrap();
        let mcp = save_mcp_server_with(
            store, &vault, None, "S", "https://s.test/mcp", "tok", false, "[]", https_ok,
        )
        .unwrap();

        let rows = get_user_registry(store, &vault).unwrap();
        let has = |id: &str| rows.iter().find(|r| r.id == id).unwrap().has_token;
        assert!(has(&secret), "a stored secret variable value must read as set");
        assert!(has(&plain), "(auth_token <> '') was true for a filled regular variable");
        assert!(!has(&empty), "...and false once it is emptied");
        assert!(has(&mcp));

        // and it goes false again when the secret is cleared
        save_variable(store, &vault, Some(&secret), "k", "", true, false).unwrap();
        let rows = get_user_registry(store, &vault).unwrap();
        assert!(!rows.iter().find(|r| r.id == secret).unwrap().has_token);
    }

    /// A regular variable is the opposite convention: the submitted plaintext is
    /// authoritative, blank included.
    #[test]
    fn a_regular_variable_takes_the_submitted_value_verbatim() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let v = save_variable(store, &vault, None, "Region", "eu-west-1", false, false).unwrap();
        save_variable(store, &vault, Some(&v), "Region", "", false, false).unwrap();
        assert_eq!(variable_value(store, &vault, &v).as_deref(), Some(""));
        assert!(!secrets::has(&vault, &Secret::Variable(&v)));
    }

    /// The substitution seam: `integrations::substitute_variables` takes this
    /// closure, and it must resolve both flavours of variable and nothing else.
    #[test]
    fn the_variable_lookup_resolves_both_flavours() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let s = save_variable(store, &vault, None, "tok", "sk-live", false, true).unwrap();
        let r = save_variable(store, &vault, None, "region", "eu", false, false).unwrap();
        let skill = save_entry(store, Kind::Skill, None, "not a variable", "", "").unwrap();

        let lookup = variable_lookup(store, &vault);
        assert_eq!(lookup(&s).as_deref(), Some("sk-live"));
        assert_eq!(lookup(&r).as_deref(), Some("eu"));
        assert_eq!(lookup(&skill), None, "a non-variable id must not resolve");
        assert_eq!(lookup("../../etc/passwd"), None);
        assert_eq!(lookup(&uuid()), None);
    }

    /// Deleting an entry must take its Keychain items and its vectors with it —
    /// both are invisible once the row that named them is gone.
    #[test]
    fn delete_sweeps_secrets_and_memory_items() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let mcp = save_mcp_server_with(
            store, &vault, None, "S", "https://s.test/mcp", "tok", false, "[]", https_ok,
        )
        .unwrap();
        write_mcp_oauth(store, &vault, &mcp, &McpOauth { access_token: Some("at".into()), ..Default::default() })
            .unwrap();
        let mem = save_entry(store, Kind::Memory, None, "Notes", "", "").unwrap();
        {
            let conn = store.conn();
            let mut ins = conn
                .prepare("insert into memory_item (embedding, entry_id, content, created_at) values (?1, ?2, ?3, ?4)")
                .unwrap();
            for (entry, text) in [(&mem, "mine"), (&mcp, "another store")] {
                ins.execute(params![crate::store::vec_blob(&vec![0.5f32; 1536]), entry, text, now()])
                    .unwrap();
            }
        }

        assert!(delete_entry(store, &vault, &mcp).unwrap());
        assert!(!secrets::has(&vault, &Secret::McpToken(&mcp)));
        assert!(!secrets::has(&vault, &Secret::McpOauth(&mcp)));
        let left: i64 = store
            .conn()
            .query_row("select count(*) from memory_item where entry_id = ?1", [&mcp], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "vec0 rows outlived their entry");
        let others: i64 = store
            .conn()
            .query_row("select count(*) from memory_item where entry_id = ?1", [&mem], |r| r.get(0))
            .unwrap();
        assert_eq!(others, 1, "the sweep took another store's items");

        assert!(!delete_entry(store, &vault, &uuid()).unwrap(), "deleting nothing is not an error");
        assert_eq!(delete_entry(store, &vault, "not-a-uuid"), Err("Invalid id".into()));

        // ...and an oauth write for a row that is already gone must not leave a
        // Keychain item nothing will ever sweep
        let gone = uuid();
        assert_eq!(
            write_mcp_oauth(store, &vault, &gone, &McpOauth { access_token: Some("at".into()), ..Default::default() }),
            Err("Not found".into())
        );
        assert!(!secrets::has(&vault, &Secret::McpOauth(&gone)), "orphaned oauth item");
    }

    /// Hostile ids must never reach a query or become a node type.
    #[test]
    fn uuid_shape_and_sentinel_parsing_reject_hostile_input() {
        let ok = "3f1a2b4c-1111-4222-8333-444455556666";
        assert!(is_uuid(ok));
        assert!(is_uuid(&ok.to_uppercase()), "the regex was case-insensitive");
        for bad in [
            "",
            "3f1a2b4c-1111-4222-8333-44445555666",   // 35
            "3f1a2b4c-1111-4222-8333-4444555566667", // 37
            "3f1a2b4c-1111-4222-8333-44445555666g",  // non-hex
            "3f1a2b4c11114222833344445555666 ",      // no dashes
            "3f1a2b4c-1111-4222-8333-444455556666\n",
            "../../../etc/passwd",
            "' or 1=1 --",
        ] {
            assert!(!is_uuid(bad), "{bad:?} must not pass as a uuid");
        }

        assert_eq!(variable_id_from_sentinel(&format!("{{{{var:{ok}}}}}")), Some(ok));
        for bad in [
            format!("prefix{{{{var:{ok}}}}}"),
            format!("{{{{var:{ok}}}}}suffix"),
            "{{var:}}".to_string(),
            "{{var:../x}}".to_string(),
            format!("{{{{var:{ok}"),
            ok.to_string(),
        ] {
            assert_eq!(variable_id_from_sentinel(&bad), None, "{bad:?} must not resolve");
        }

        assert_eq!(user_node_key(Kind::Skill, ok), format!("skill:{ok}"));
    }

    /// Least privilege on discovery, and the call gate that backs it up.
    #[test]
    fn merge_tools_and_the_call_gate_stay_least_privilege() {
        let existing = vec![
            McpTool { name: "search".into(), access: "write".into(), enabled: true, read_only: None, description: Some("stale".into()), params: None },
            McpTool { name: "gone".into(), access: "write".into(), enabled: true, ..Default::default() },
        ];
        let discovered = vec![
            // a kept tool the server now declares read-only: the write grant is
            // capped, the stale description is replaced
            DiscoveredTool { name: "search".into(), read_only: Some(true), description: "fresh".into(), params: vec![] },
            DiscoveredTool { name: "write_page".into(), read_only: Some(false), description: String::new(), params: vec![] },
            DiscoveredTool { name: "unknown".into(), read_only: None, description: String::new(), params: vec![] },
        ];
        let merged = merge_tools(&existing, &discovered);
        assert_eq!(merged.len(), 3, "discovery replaces the list — 'gone' must not survive");
        assert_eq!((merged[0].access.as_str(), merged[0].enabled), ("read", true));
        assert_eq!(merged[0].description.as_deref(), Some("fresh"));
        assert_eq!((merged[1].access.as_str(), merged[1].enabled), ("write", false));
        assert_eq!((merged[2].access.as_str(), merged[2].enabled), ("read", false));

        // the cap truncates, it does not error
        let many: Vec<_> = (0..MAX_MCP_TOOLS + 5)
            .map(|i| DiscoveredTool { name: format!("t{i}"), read_only: None, description: String::new(), params: vec![] })
            .collect();
        assert_eq!(merge_tools(&[], &many).len(), MAX_MCP_TOOLS);

        // the gate: only a provable mismatch blocks
        let gated = |read_only, access: &str| {
            can_call_tool(&McpTool { name: "t".into(), access: access.into(), enabled: true, read_only, ..Default::default() })
        };
        assert!(!gated(Some(false), "read"), "declared write-capable + read grant must block");
        assert!(gated(Some(false), "write"));
        assert!(gated(Some(true), "read"));
        assert!(gated(None, "read"), "unknown capability trusts the grant");
    }

    /// parseTools is a trust boundary — the tool list arrives as a JSON string
    /// from the client.
    #[test]
    fn parse_tools_rejects_malformed_lists() {
        assert_eq!(parse_tools("[]").unwrap(), vec![]);
        for (raw, err) in [
            ("{}", "Invalid tools"),
            ("not json", "Invalid tools"),
            (r#"[null]"#, "Invalid tools"),
            (r#"[{"access":"read","enabled":true}]"#, "Tool names must be 1-60 chars"),
            (r#"[{"name":"  ","access":"read","enabled":true}]"#, "Tool names must be 1-60 chars"),
            (r#"[{"name":"a","access":"admin","enabled":true}]"#, "Invalid tool access"),
            (r#"[{"name":"a","access":"read","enabled":"yes"}]"#, "Invalid tools"),
            (
                r#"[{"name":"a","access":"read","enabled":true},{"name":" a ","access":"write","enabled":true}]"#,
                "Duplicate tool name: a",
            ),
        ] {
            assert_eq!(parse_tools(raw), Err(err.to_string()), "{raw}");
        }
        let long = "x".repeat(61);
        assert!(parse_tools(&format!(r#"[{{"name":"{long}","access":"read","enabled":true}}]"#)).is_err());
        // over the cap
        let many: String = (0..MAX_MCP_TOOLS + 1)
            .map(|i| format!(r#"{{"name":"t{i}","access":"read","enabled":true}}"#))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_tools(&format!("[{many}]")), Err("Invalid tools".into()));
    }

    /// The save-time URL guard is not decorative: a refused URL must leave no
    /// row and no Keychain item behind.
    #[test]
    fn a_refused_server_url_writes_nothing() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let err = save_mcp_server_with(
            store, &vault, None, "S", "http://169.254.169.254/", "tok", false, "[]", https_refuse,
        )
        .unwrap_err();
        assert_eq!(err, "Server URL must be https");
        assert!(get_user_registry(store, &vault).unwrap().is_empty());
    }

    /// Caps and name validation, per kind.
    #[test]
    fn caps_and_names_are_enforced_on_insert_only() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        assert_eq!(
            save_entry(store, Kind::Skill, None, "  ", "", ""),
            Err("Name is required (max 60 chars)".into())
        );
        assert_eq!(
            save_entry(store, Kind::Skill, None, &"x".repeat(61), "", ""),
            Err("Name is required (max 60 chars)".into())
        );
        assert_eq!(save_entry(store, Kind::Skill, None, "s", "", &"x".repeat(2001)), Err("Instructions too long".into()));
        assert_eq!(save_entry(store, Kind::Memory, None, "m", "", &"x".repeat(2001)), Err("Note too long".into()));
        assert_eq!(save_entry(store, Kind::Skill, Some("nope"), "s", "", ""), Err("Invalid id".into()));
        assert_eq!(
            save_variable(store, &vault, None, "v", "", false, true),
            Err("Value is required".into())
        );

        for i in 0..MAX_ENTRIES_PER_KIND {
            save_entry(store, Kind::Skill, None, &format!("s{i}"), "", "").unwrap();
        }
        assert_eq!(
            save_entry(store, Kind::Skill, None, "one too many", "", ""),
            Err("Limit of 50 skill entries reached".into())
        );
        // the cap is on insert; an update of an existing row still works
        let existing = get_user_registry(store, &vault).unwrap()[0].id.clone();
        save_entry(store, Kind::Skill, Some(&existing), "renamed", "", "").unwrap();
        // ...and it is per kind
        save_entry(store, Kind::Memory, None, "still fine", "", "").unwrap();
    }

    /// The catalog shape every designer node and every grant edge is resolved
    /// against.
    #[test]
    fn build_user_catalog_shapes_each_chip() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let mcp = save_mcp_server_with(store, &vault, None, "Notion", "https://n.test/mcp", "", false, "[]", https_ok)
            .unwrap();
        let skill = save_entry(store, Kind::Skill, None, "Tone", "", "").unwrap();
        let memory = save_entry(store, Kind::Memory, None, "Notes", "", "").unwrap();
        let var = save_variable(store, &vault, None, "Key", "v", false, true).unwrap();

        let catalog = build_user_catalog(&get_user_registry(store, &vault).unwrap());
        assert_eq!(catalog.len(), 4);

        let server = &catalog[&format!("mcp:{mcp}:*")];
        assert_eq!(server.category, "mcp");
        assert_eq!(server.label, "Notion");
        assert_eq!(server.tool_name.as_deref(), Some("*"), "no toolName means no grant edge");
        assert_eq!(server.outputs[0].id, "tool");
        assert_eq!(server.config[0].id, "exclude");
        assert!(!server.missing);

        assert_eq!(catalog[&format!("skill:{skill}")].outputs[0].id, "skill");
        assert_eq!(catalog[&format!("memory:{memory}")].outputs[0].id, "memory");
        assert_eq!(catalog[&format!("variable:{var}")].outputs[0].id, "value");
        for e in catalog.values() {
            assert_eq!(e.outputs[0].kind, "value");
        }
    }

    /// The refresh path: an expired token is refreshed once, the rotated refresh
    /// token is persisted, and a response without `expires_in` clears the expiry
    /// rather than keeping the stale one.
    #[test]
    fn fresh_mcp_token_refreshes_and_persists() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(store, &vault, None, "S", "https://s.test/mcp", "", false, "[]", https_ok)
            .unwrap();
        let expired = McpOauth {
            client_id: Some("cid".into()),
            token_url: Some("https://s.test/token".into()),
            access_token: Some("old-at".into()),
            refresh_token: Some("old-rt".into()),
            expires_at: Some(now() - 1),
            ..Default::default()
        };
        write_mcp_oauth(store, &vault, &id, &expired).unwrap();

        fn rotate(_: &McpOauth, resource: &str) -> Result<TokenSet, String> {
            assert_eq!(resource, "https://s.test/mcp", "the resource is the server url");
            Ok(TokenSet { access_token: "new-at".into(), refresh_token: Some("new-rt".into()), expires_at: None })
        }
        fn never(_: &McpOauth, _: &str) -> Result<TokenSet, String> {
            panic!("must not refresh");
        }

        let entry = mcp_secrets(store, &vault, &id).unwrap().unwrap();
        let (token, oauth) = fresh_mcp_token_with(store, &vault, &entry, rotate).unwrap();
        assert_eq!(token.as_deref(), Some("new-at"));
        assert_eq!(oauth.refresh_token.as_deref(), Some("new-rt"), "the rotated token must win");
        assert_eq!(oauth.expires_at, None, "an absent expires_in clears the expiry");
        // persisted, so the next call does not retry with the dead refresh token
        let reread = mcp_secrets(store, &vault, &id).unwrap().unwrap();
        assert_eq!(reread.oauth.access_token.as_deref(), Some("new-at"));
        assert_eq!(reread.oauth.refresh_token.as_deref(), Some("new-rt"));
        // no expiry now → not refreshable, and the manual token short-circuits
        fresh_mcp_token_with(store, &vault, &reread, never).unwrap();

        secrets::set(&vault, &Secret::McpToken(&id), Some("manual"), false).unwrap();
        let with_manual = mcp_secrets(store, &vault, &id).unwrap().unwrap();
        let (token, _) = fresh_mcp_token_with(store, &vault, &with_manual, never).unwrap();
        assert_eq!(token.as_deref(), Some("manual"), "a manual token wins over oauth");
    }

    /// An unexpired token must not be refreshed, and neither must an incomplete
    /// set — a missing token_url or client_id would make the refresh call
    /// impossible to build.
    #[test]
    fn fresh_mcp_token_leaves_a_valid_or_incomplete_set_alone() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(store, &vault, None, "S", "https://s.test/mcp", "", false, "[]", https_ok)
            .unwrap();
        fn never(_: &McpOauth, _: &str) -> Result<TokenSet, String> {
            panic!("must not refresh");
        }
        let base = McpOauth {
            client_id: Some("cid".into()),
            token_url: Some("https://s.test/token".into()),
            access_token: Some("at".into()),
            refresh_token: Some("rt".into()),
            expires_at: Some(now() + 60_000),
            ..Default::default()
        };
        for oauth in [
            base.clone(),                                                     // not expired
            McpOauth { expires_at: Some(now() - 1), token_url: None, ..base.clone() },
            McpOauth { expires_at: Some(now() - 1), client_id: None, ..base.clone() },
            McpOauth { expires_at: Some(now() - 1), refresh_token: None, ..base.clone() },
            McpOauth { expires_at: None, ..base.clone() },
        ] {
            write_mcp_oauth(store, &vault, &id, &oauth).unwrap();
            let entry = mcp_secrets(store, &vault, &id).unwrap().unwrap();
            let (token, _) = fresh_mcp_token_with(store, &vault, &entry, never).unwrap();
            assert_eq!(token.as_deref(), Some("at"));
        }
    }

    /// A settings save re-sends only {name, access, enabled}; the discovered
    /// metadata must survive it, or the agent loses every tool description and
    /// arg spec on an unrelated rename.
    #[test]
    fn saving_an_mcp_entry_keeps_discovered_metadata() {
        let t = Tmp::new();
        let (store, vault) = (&t.1, FakeVault::default());
        let id = save_mcp_server_with(store, &vault, None, "S", "https://s.test/mcp", "", false, "[]", https_ok)
            .unwrap();
        set_mcp_tools(
            store,
            &id,
            merge_tools(
                &[],
                &[DiscoveredTool {
                    name: "search".into(),
                    read_only: Some(true),
                    description: "full text search".into(),
                    params: vec![McpToolParam {
                        name: "q".into(),
                        param_type: crate::mcp::McpToolParamType::String,
                        required: true,
                        description: None,
                    }],
                }],
            ),
        )
        .unwrap();

        save_mcp_server_with(
            store, &vault, Some(&id), "S", "https://s.test/mcp", "", false,
            r#"[{"name":"search","access":"read","enabled":false}]"#, https_ok,
        )
        .unwrap();

        let tools = mcp_secrets(store, &vault, &id).unwrap().unwrap().tools;
        assert_eq!(tools[0].description.as_deref(), Some("full text search"));
        assert_eq!(tools[0].params.as_ref().unwrap()[0].name, "q");
        assert_eq!(tools[0].read_only, Some(true));
        assert!(!tools[0].enabled, "the submitted grant still wins");
    }
}
