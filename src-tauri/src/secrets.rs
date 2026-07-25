//! The Keychain layer. Everything the Postgres schema used to keep in plaintext
//! columns — `user_secret.openrouter_key`, `registry_entry.auth_token`, the
//! `oauth` jsonb, a secret variable's value — lives here instead, which is why
//! those columns do not exist in `store.rs`'s SCHEMA.
//!
//! Two rules the rest of the app depends on:
//!
//! 1. **Write-only.** A blank input KEEPS the stored value, an explicit clear
//!    removes it, and no read path hands a secret to the UI — only a boolean
//!    (`has`). `set` is where that convention is enforced, because it is the one
//!    place a mistake silently destroys the user's key.
//! 2. **Nothing outlives its owner.** `registry::delete_entry` calls
//!    `delete_entry_secrets`, so deleting an MCP server takes its token, its
//!    OAuth set and (for a variable) its value with it. An orphaned token in the
//!    Keychain is a real leak — the row that gave it meaning is gone, so nothing
//!    will ever clean it up.
//!
//! Reached from the IPC commands in `main.rs` (`has_openrouter_key`,
//! `set_openrouter_key`, every registry save/delete) and, per run, from
//! `runner::openrouter_key` and `registry::get_user_registry`. The bundled
//! `ui/index.html` is still the dev shell, so only `test_run` exercises it today.

use keyring::Entry;

/// Keychain service name — the Tauri bundle identifier from `tauri.conf.json`.
///
/// **Never change this.** macOS keys generic passwords by (service, account);
/// renaming the service orphans every secret this app has ever stored — the
/// OpenRouter key, every MCP token, every secret variable — with no migration
/// path, because the old items are still there under a name nothing looks up.
pub const SERVICE: &str = "com.wilcus.saturn";

/// The account-name scheme. This is a migration surface forever: an account
/// string that ships once is a key in the user's Keychain, so these formats are
/// as permanent as `SERVICE` itself.
///
/// - `openrouter-key`   — the single BYOK OpenRouter key (was `user_secret`)
/// - `github-pat`       — the single fine-grained read-only PAT the GitHub
///   poller authenticates with. Like the OpenRouter key it belongs to the app,
///   not to a registry entry, so `delete_entry_secrets` must never sweep it.
/// - `mcp-token:<uuid>` — a registry entry's manual bearer token (`auth_token`)
/// - `mcp-oauth:<uuid>` — that entry's whole `McpOauth` set, as JSON
/// - `variable:<uuid>`  — a *secret* variable's plaintext value
///
/// The `<kind>:<uuid>` shape is what makes an entry id unambiguous: three
/// different secrets can belong to the same registry entry, and
/// `delete_entry_secrets` sweeps all of them by id.
///
/// A non-secret variable's value is deliberately NOT here — it is viewable
/// plaintext by the user's own choice (`secret=false`) and lives in the row's
/// `config` blob, so the registry read path never has to touch the Keychain for
/// it. See `registry::get_user_registry`.
pub enum Secret<'a> {
    OpenRouterKey,
    GithubPat,
    McpToken(&'a str),
    McpOauth(&'a str),
    Variable(&'a str),
}

impl Secret<'_> {
    pub fn account(&self) -> String {
        match self {
            Secret::OpenRouterKey => "openrouter-key".to_string(),
            // must stay exactly this string — github.rs shipped reading it
            Secret::GithubPat => "github-pat".to_string(),
            Secret::McpToken(id) => format!("mcp-token:{id}"),
            Secret::McpOauth(id) => format!("mcp-oauth:{id}"),
            Secret::Variable(id) => format!("variable:{id}"),
        }
    }
}

/// The storage seam. Its only production implementation is `Keychain`; it exists
/// so tests can exercise the keep/clear convention without reading or writing
/// the real macOS Keychain (which would prompt, would leak test items into the
/// user's login keychain, and would make the suite machine-dependent).
pub trait Vault: Send + Sync {
    fn read(&self, account: &str) -> Option<String>;
    fn write(&self, account: &str, value: &str) -> Result<(), String>;
    fn erase(&self, account: &str) -> Result<(), String>;
}

/// The macOS login Keychain, via the `keyring` crate's apple-native backend.
/// Zero-sized: the Keychain itself is the state, this is just the door.
pub struct Keychain;

/// The one production vault. A `const` of a zero-sized type, not a lazily
/// initialized global — there is nothing to initialize.
pub const KEYCHAIN: Keychain = Keychain;

impl Vault for Keychain {
    fn read(&self, account: &str) -> Option<String> {
        // A missing item and a broken Keychain are both "no secret" to every
        // caller here; the alternative is threading a Result through the whole
        // registry read path to say "maybe there is a token, maybe not".
        Entry::new(SERVICE, account).ok()?.get_password().ok()
    }

    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn erase(&self, account: &str) -> Result<(), String> {
        match Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
            // erasing what is already gone is success — delete_entry_secrets
            // sweeps all three accounts of an entry that may only have had one
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The stored secret, or `None` when unset. An empty string reads as unset: the
/// Postgres original stored `''` for "cleared" and every call site tested
/// `auth_token <> ''`, so an empty value must never look like a present one.
pub fn get(vault: &dyn Vault, secret: &Secret) -> Option<String> {
    vault.read(&secret.account()).filter(|v| !v.is_empty())
}

/// The whole read path the UI gets. `has_token` / `connected` in the registry
/// row are booleans for this reason — the client never sees a secret.
pub fn has(vault: &dyn Vault, secret: &Secret) -> bool {
    get(vault, secret).is_some()
}

/// The write-only convention, verbatim from the TypeScript's SQL:
/// `clear` wins, a non-blank `input` overwrites, and **blank keeps** — a form
/// that renders a stored secret as an empty box (which is the only way to render
/// one) must not erase it on every unrelated save.
///
/// `None` and `Some("")` are the same thing: the field was left alone.
pub fn set(
    vault: &dyn Vault,
    secret: &Secret,
    input: Option<&str>,
    clear: bool,
) -> Result<(), String> {
    let account = secret.account();
    if clear {
        return vault.erase(&account);
    }
    match input.unwrap_or("") {
        "" => Ok(()), // KEEP — never an overwrite-with-empty
        value => vault.write(&account, value),
    }
}

/// Every secret belonging to one registry entry. Called from
/// `registry::delete_entry` and nowhere else, so the sweep cannot be forgotten
/// at a call site — if a new per-entry secret is ever added to `Secret`, add it
/// here in the same change.
pub fn delete_entry_secrets(vault: &dyn Vault, entry_id: &str) -> Result<(), String> {
    vault.erase(&Secret::McpToken(entry_id).account())?;
    vault.erase(&Secret::McpOauth(entry_id).account())?;
    vault.erase(&Secret::Variable(entry_id).account())
}

/// An in-memory vault for tests. Lives outside the `tests` module so the
/// registry tests next door can use it too — nothing in production constructs
/// one, and it is the reason no test touches the real Keychain.
#[cfg(test)]
#[derive(Default)]
pub struct FakeVault(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl Vault for FakeVault {
    fn read(&self, account: &str) -> Option<String> {
        self.0.lock().unwrap().get(account).cloned()
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn erase(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The single most likely place to silently destroy the user's key: a save
    /// that leaves the (necessarily blank) secret field alone must KEEP, and
    /// only the explicit clear checkbox may remove. Both directions are tested
    /// because a `set` that always writes and a `set` that never writes both
    /// pass a one-sided test.
    #[test]
    fn blank_keeps_and_only_the_checkbox_clears() {
        let v = FakeVault::default();
        let key = Secret::OpenRouterKey;

        assert!(!has(&v, &key));
        set(&v, &key, Some("sk-or-real"), false).unwrap();
        assert_eq!(get(&v, &key).as_deref(), Some("sk-or-real"));

        // a save with the field untouched — both spellings of "untouched"
        set(&v, &key, Some(""), false).unwrap();
        assert_eq!(get(&v, &key).as_deref(), Some("sk-or-real"), "blank must KEEP");
        set(&v, &key, None, false).unwrap();
        assert_eq!(get(&v, &key).as_deref(), Some("sk-or-real"), "None must KEEP");

        // a filled field overwrites
        set(&v, &key, Some("sk-or-new"), false).unwrap();
        assert_eq!(get(&v, &key).as_deref(), Some("sk-or-new"));

        // clear wins over whatever is in the box, exactly as the SQL's
        // `if (clearToken) ... else if (authToken)` ordering did
        set(&v, &key, Some("sk-or-ignored"), true).unwrap();
        assert!(!has(&v, &key), "the clear checkbox must erase");
        assert_eq!(get(&v, &key), None);
    }

    /// An empty stored value must not read as "present" — the Postgres original
    /// wrote `''` on clear and every caller compared `<> ''`.
    #[test]
    fn empty_reads_as_unset() {
        let v = FakeVault::default();
        v.write(&Secret::McpToken("id").account(), "").unwrap();
        assert!(!has(&v, &Secret::McpToken("id")));
    }

    /// The account scheme is a permanent migration surface — pin it.
    #[test]
    fn account_scheme_is_stable_and_unambiguous() {
        let id = "3f1a2b4c-0000-4000-8000-000000000001";
        assert_eq!(Secret::OpenRouterKey.account(), "openrouter-key");
        assert_eq!(Secret::McpToken(id).account(), format!("mcp-token:{id}"));
        assert_eq!(Secret::McpOauth(id).account(), format!("mcp-oauth:{id}"));
        assert_eq!(Secret::Variable(id).account(), format!("variable:{id}"));
        // the three per-entry secrets of the same entry never collide
        let accounts = [
            Secret::McpToken(id).account(),
            Secret::McpOauth(id).account(),
            Secret::Variable(id).account(),
        ];
        let distinct: std::collections::HashSet<_> = accounts.iter().collect();
        assert_eq!(distinct.len(), 3);
    }

    /// Deleting an entry must take all of its secrets, not just the one the
    /// caller happened to think of.
    #[test]
    fn delete_entry_secrets_sweeps_every_account() {
        let v = FakeVault::default();
        let id = "3f1a2b4c-0000-4000-8000-000000000002";
        set(&v, &Secret::McpToken(id), Some("t"), false).unwrap();
        set(&v, &Secret::McpOauth(id), Some("{}"), false).unwrap();
        set(&v, &Secret::Variable(id), Some("v"), false).unwrap();
        // a neighbour that must survive
        set(&v, &Secret::Variable("other"), Some("keep"), false).unwrap();

        delete_entry_secrets(&v, id).unwrap();

        assert!(!has(&v, &Secret::McpToken(id)));
        assert!(!has(&v, &Secret::McpOauth(id)));
        assert!(!has(&v, &Secret::Variable(id)));
        assert!(has(&v, &Secret::Variable("other")));
        // idempotent: sweeping an already-swept entry is not an error
        delete_entry_secrets(&v, id).unwrap();
    }
}
