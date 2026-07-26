//! GitHub events, by polling one endpoint per watched resource.
//!
//! The deleted `lib/github.server.ts` polled `/repos/{o}/{r}/events` and was
//! blamed for lag; its own header comment names the real cause — that endpoint
//! is documented as *not* real-time (30s–6h, 60s cache). The five endpoints
//! below read primary data and carry no such caveat, so latency becomes the poll
//! interval. Everything else in that file is ported branch for branch.
//!
//! | node             | endpoint                                                     | cursor       |
//! |------------------|--------------------------------------------------------------|--------------|
//! | `github-push`    | `/repos/{o}/{r}/git/refs/heads/{branch}` + compare API        | head SHA     |
//! | `github-issue`   | `/repos/{o}/{r}/issues?sort=created&direction=desc&state=all` | issue number |
//! | `github-pr`      | `/repos/{o}/{r}/pulls?sort=created&direction=desc&state=all`  | PR number    |
//! | `github-release` | `/repos/{o}/{r}/releases`                                     | release id   |
//! | `github-star`    | `/repos/{o}/{r}/stargazers` (star+json, last page)            | `starred_at` |
//!
//! Three things here are load-bearing and must survive any later edit:
//!
//! 1. **The baseline cursor.** The first poll of a resource records the current
//!    max and dispatches NOTHING. Without it, saving a workflow replays the
//!    repo's entire history as events the first time it polls.
//! 2. **The error taxonomy.** 401 kills the poller until the PAT changes (a bad
//!    token never fixes itself); 404/451 retry at 15 min (a renamed repo, or a
//!    token without access, is fixable outside Saturn); 403/429 sleep to the
//!    rate-limit reset; everything else backs off exponentially.
//! 3. **Conditional requests.** A 304 costs no rate-limit quota, which is the
//!    only reason a 30s interval is free. The ETag is stored per resource next
//!    to its cursor.
//!
//! Cursors live in their own `github_cursor` table rather than in memory: a
//! memory-only cursor re-baselines on every launch, which is the history-replay
//! bug with extra steps. What a persisted cursor does NOT buy is catch-up: a
//! poll that wakes to a weekend of backlog advances past all of it and
//! dispatches only what is younger than `SKIP_OLDER_THAN_S`.
//!
//! Auth is one fine-grained read-only PAT in the Keychain, shared by every
//! watch. It is optional for four of the five resources (public repos poll
//! unauthenticated at 60 req/hr, and 304s are free either way); a malformed one
//! is treated exactly like a 401. `github-star` is the exception — it cannot be
//! polled without a PAT and is skipped, see `Resource::pollable`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::HeaderMap;
use reqwest::redirect;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::events::{self, EventSubscription, MAX_EVENT_PAYLOAD};
use crate::interpreter::js::{self, J};
use crate::interpreter::utf16_prefix;
use crate::secrets::{self, Secret, Vault, KEYCHAIN};
use crate::store::Store;

const API_BASE: &str = "https://api.github.com";
const API_HOST: &str = "api.github.com";
/// Per-resource cadence, and the floor of the `X-Poll-Interval` clamp so a bad
/// header can neither stall the loop nor make it hammer.
const POLL_S: u64 = 30;
const MAX_POLL_S: u64 = 300;
/// Matches the TypeScript's `REFRESH_DEBOUNCE_MS`: a designer autosave burst
/// pokes `subscriptions_changed()` repeatedly and must collapse to one re-poll.
const REFRESH_DEBOUNCE: Duration = Duration::from_secs(2);
/// Constant on purpose — changing `per_page` invalidates every stored ETag.
const PER_PAGE: u32 = 50;
const STAR_PER_PAGE: u32 = 100;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const ENRICH_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const RATE_LIMIT_MIN_SLEEP: Duration = Duration::from_secs(60);
const RATE_LIMIT_MAX_SLEEP: Duration = Duration::from_secs(3_600);
/// 404/451 retry cadence — the repo is fixable outside Saturn, so this is slow
/// but never permanent.
const NOT_FOUND_RETRY: Duration = Duration::from_secs(900);
/// Ignore anything older than 15 minutes. The cursor persists, so a laptop that
/// slept through the weekend wakes with a whole page of issues, PRs and stars
/// above it, and dispatching those replays week-old work into Discord as if it
/// had just happened. Losing the backlog of a sleep is the cheaper failure — the
/// deleted `lib/github.server.ts` carried the same 900s and called it "the
/// secondary guard against replay".
///
/// Wider than Telegram's 300s (`telegram.rs`) because this poll can legitimately
/// be minutes behind: `X-Poll-Interval` may stretch the cadence to `MAX_POLL_S`,
/// and a backoff or a 404 park stretches one watch further still. A tighter
/// window would drop events that really were live.
///
/// The rate-limit interaction is deliberate, not an oversight: `resume_at` is
/// global and `RATE_LIMIT_MAX_SLEEP` is an hour, so the pass after a long park
/// skips events that were live when the park began. That is the decision —
/// nothing replays — and the cursor advances over them regardless, so they are
/// skipped once rather than re-examined on every poll forever.
const SKIP_OLDER_THAN_S: i64 = 900;
const MAX_BODY_CHARS: usize = 4_000;
/// Final re-slice when the built JSON still exceeds `MAX_EVENT_PAYLOAD`.
const GUARD_BODY_CHARS: usize = 1_000;
const MAX_COMMIT_MESSAGES: usize = 5;
const MAX_COMMIT_MESSAGE_CHARS: usize = 200;

// GitHub rejects requests without a User-Agent; the api-version + accept headers
// pin the response shape.
const USER_AGENT: &str = "Saturn-Workflows (https://saturn.wilcus.com)";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
/// Stargazers only carry `starred_at` under this media type.
const STAR_ACCEPT: &str = "application/vnd.github.star+json";
const GITHUB_API_VERSION: &str = "2022-11-28";

// --- validators -------------------------------------------------------------
//
// Config never shapes the fetch target. `repo` and `branch` are interpolated
// into a URL *path*, so these are SSRF guards, not formatting niceties: the
// charsets exclude "/" beyond the single owner/repo separator, "..", "%", "?"
// and "#", which is what stops a traversal or a query-string injection from
// pointing the request somewhere other than the repo the user named. The token
// rides the Authorization header only, and is charset-checked so a
// deleted-variable sentinel left literal in a field cannot travel as one.

/// `/^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,120}$/`, plus: no whole segment may
/// be "." or "..".
fn valid_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    let seg = |s: &str, max: usize| {
        (1..=max).contains(&s.len())
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
            && s != "."
            && s != ".."
    };
    seg(owner, 60) && seg(name, 120)
}

/// Branch names legitimately contain "/" (`feature/retries`), so the guard runs
/// per segment: no empty segment (which would collapse `//` or a leading slash
/// into a different path), no "." or ".." segment, and a charset with no "%",
/// "?", "#", ":" or control bytes — so there is no percent-decoding surprise and
/// nothing to escape when it is spliced into the path.
fn valid_branch(branch: &str) -> bool {
    (1..=255).contains(&branch.len())
        && branch.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

/// `/^[A-Za-z0-9_]{20,255}$/` — covers `ghp_…` and the `github_pat_…`
/// fine-grained tokens this app asks for.
fn valid_token(token: &str) -> bool {
    (20..=255).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// `/^[0-9a-f]{7,40}$/` — the compare call's endpoints come out of an API
/// payload, but keep the URL-shaping discipline anyway.
fn valid_sha(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// --- untrusted-payload accessors --------------------------------------------
// The API response is never assumed well-shaped. `Value`'s Index returns Null
// for a missing key or a non-object, so these are total.

fn s(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// A number-or-string field as a string — the TypeScript's `numStr`.
fn num_str(v: &Value, key: &str) -> String {
    match &v[key] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn body_text(v: &Value, key: &str) -> String {
    let raw = s(v, key);
    utf16_prefix(&raw, MAX_BODY_CHARS).unwrap_or(raw)
}

fn now_ms() -> i64 {
    // never unwrap: a clock behind 1970 (a dead RTC on a fresh boot) would panic
    // inside spawn_blocking and take the whole GitHub loop down for the session.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

// --- the age guard ----------------------------------------------------------

/// `2026-07-18T12:34:56Z` → epoch ms, the one shape every GitHub timestamp
/// arrives in (fractional seconds tolerated). UTC only: an offset, a missing Z
/// or a garbage field returns `None`, which `fresh` reads as "not stale".
fn parse_utc_ms(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 20 || b.last() != Some(&b'Z') {
        return None;
    }
    if (b[4], b[7], b[10], b[13], b[16]) != (b'-', b'-', b'T', b':', b':') {
        return None;
    }
    // `get`, not a range index: a slice landing mid-codepoint panics
    let f = |r: std::ops::Range<usize>| -> Option<i64> { ts.get(r)?.parse().ok() };
    let (y, mo, d) = (f(0..4)?, f(5..7)?, f(8..10)?);
    let (h, mi, s) = (f(11..13)?, f(14..16)?, f(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // days_from_civil (Howard Hinnant), era-based and exact over the whole range
    let ay = if mo <= 2 { y - 1 } else { y };
    let era = if ay >= 0 { ay } else { ay - 399 } / 400;
    let yoe = ay - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000)
}

/// Whether an event is young enough to dispatch. Fails OPEN on an unreadable
/// timestamp — the TypeScript's `Number.isFinite(created)` did the same, and a
/// push whose compare call failed carries no timestamp at all yet must still be
/// delivered. A clock skewed into the future is also fresh.
fn fresh(ts: &str, now: i64) -> bool {
    parse_utc_ms(ts).is_none_or(|ms| now - ms <= SKIP_OLDER_THAN_S * 1_000)
}

/// Every `Built` carries the resource's own timestamp in its `timestamp` field —
/// `created_at` for issue/pr, `published_at` for release, `starred_at` for star,
/// the head commit's date for push.
fn fresh_built(built: &Built, now: i64) -> bool {
    fresh(&text(&built.fields, "timestamp"), now)
}

// --- resources --------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Resource {
    Push,
    Issue,
    Pr,
    Release,
    Star,
}

impl Resource {
    /// The `EventSubscription.event` id (no `event:` prefix) this resource feeds.
    fn from_event(event: &str) -> Option<Resource> {
        Some(match event {
            "github-push" => Resource::Push,
            "github-issue" => Resource::Issue,
            "github-pr" => Resource::Pr,
            "github-release" => Resource::Release,
            "github-star" => Resource::Star,
            _ => return None,
        })
    }

    /// Also the cursor-key component, so this string is half of a persisted
    /// primary key: renaming one re-baselines every watch of that kind.
    fn as_str(self) -> &'static str {
        match self {
            Resource::Push => "github-push",
            Resource::Issue => "github-issue",
            Resource::Pr => "github-pr",
            Resource::Release => "github-release",
            Resource::Star => "github-star",
        }
    }

    /// `github-star` is the one resource that cannot run unauthenticated. Page 1
    /// of `/stargazers` is fetched without an ETag by design (see `poll_watch`), so
    /// every poll costs rate-limit quota where the other four spend 304s that
    /// cost none — ~120 counted requests/hour for one watch against a 60/hour
    /// anonymous budget. The 403 that follows parks *every* watch through the
    /// global `resume_at`, and anything landing during a park longer than
    /// `SKIP_OLDER_THAN_S` is dropped rather than delayed. One unauthenticated
    /// star watch therefore makes every other watch lossy. The toolbox greys the
    /// chip out; this is the guard for graphs that already hold one.
    fn pollable(self, token: &str) -> bool {
        self != Resource::Star || !token.is_empty()
    }

    fn accept(self) -> &'static str {
        match self {
            Resource::Star => STAR_ACCEPT,
            _ => GITHUB_ACCEPT,
        }
    }

    fn path(self, repo: &str, branch: &str) -> String {
        match self {
            Resource::Push => format!("/repos/{repo}/git/refs/heads/{branch}"),
            Resource::Issue => {
                // state=all, as the pulls endpoint already does: the default is
                // `open`, so an issue opened and closed inside one poll interval
                // would never appear and never fire.
                format!(
                    "/repos/{repo}/issues?sort=created&direction=desc&state=all&per_page={PER_PAGE}"
                )
            }
            Resource::Pr => format!(
                "/repos/{repo}/pulls?sort=created&direction=desc&state=all&per_page={PER_PAGE}"
            ),
            Resource::Release => format!("/repos/{repo}/releases?per_page={PER_PAGE}"),
            Resource::Star => format!("/repos/{repo}/stargazers?per_page={STAR_PER_PAGE}"),
        }
    }
}

/// One built event: the payload a graph sees, plus the branch the push filter
/// matches on. The builders below ARE the definition of each `github-*` payload
/// shape — `sample_payload` runs them over canned API objects to seed designer
/// test runs, and every existing workflow reads the same field order, so it
/// must not drift.
struct Built {
    event: &'static str,
    branch: String,
    fields: Vec<(String, J)>,
}

fn text(fields: &[(String, J)], key: &str) -> String {
    match fields.iter().find(|(k, _)| k == key) {
        Some((_, J::S(v))) => v.clone(),
        _ => String::new(),
    }
}

fn strings(items: Vec<String>) -> J {
    J::A(items.into_iter().map(J::S).collect())
}

fn field(key: &str, value: impl Into<String>) -> (String, J) {
    (key.to_string(), J::S(value.into()))
}

/// `J` is deliberately not `Clone` in the interpreter, and adding a derive there
/// is another module's file.
fn clone_j(j: &J) -> J {
    match j {
        J::Null => J::Null,
        J::B(b) => J::B(*b),
        J::N(n) => J::N(*n),
        J::S(s) => J::S(s.clone()),
        J::A(items) => J::A(items.iter().map(clone_j).collect()),
        J::O(fields) => J::O(fields.iter().map(|(k, v)| (k.clone(), clone_j(v))).collect()),
    }
}

// --- payload builders -------------------------------------------------------
// Ported from lib/githubApp.server.ts:161-226 (buildIssue/buildPr/buildRelease)
// and the poller's own buildPush. Those took the webhook envelope (`p.issue`,
// `p.pull_request`, `p.release`); the REST list endpoints hand back the object
// itself, so these take that object directly. Every value is a string.

fn build_push(repo: &str, branch: &str, before: &str, head: &str) -> Built {
    Built {
        event: "github-push",
        branch: branch.to_string(),
        fields: vec![
            field("repo", repo),
            field("ref", format!("refs/heads/{branch}")),
            field("branch", branch),
            // pusher/commitCount/messages/timestamp are what the compare call
            // fills in; an unenrichable push reports "0" and [] rather than
            // being dropped.
            field("pusher", ""),
            field("commitCount", "0"),
            field("headSha", head),
            field("beforeSha", before),
            ("messages".into(), strings(Vec::new())),
            field(
                "compareUrl",
                if before.is_empty() || head.is_empty() {
                    String::new()
                } else {
                    format!("https://github.com/{repo}/compare/{before}...{head}")
                },
            ),
            field("timestamp", ""),
        ],
    }
}

fn build_issue(repo: &str, issue: &Value) -> Built {
    Built {
        event: "github-issue",
        branch: String::new(),
        fields: vec![
            field("repo", repo),
            field("number", num_str(issue, "number")),
            field("title", s(issue, "title")),
            field("body", body_text(issue, "body")),
            field("author", s(&issue["user"], "login")),
            (
                "labels".into(),
                strings(
                    arr(&issue["labels"])
                        .iter()
                        .map(|l| s(l, "name"))
                        .filter(|n| !n.is_empty())
                        .collect(),
                ),
            ),
            field("url", s(issue, "html_url")),
            field("timestamp", s(issue, "created_at")),
        ],
    }
}

fn build_pr(repo: &str, pr: &Value) -> Built {
    Built {
        event: "github-pr",
        branch: String::new(),
        fields: vec![
            field("repo", repo),
            field("number", num_str(pr, "number")),
            field("title", s(pr, "title")),
            field("body", body_text(pr, "body")),
            field("author", s(&pr["user"], "login")),
            field("sourceBranch", s(&pr["head"], "ref")),
            field("targetBranch", s(&pr["base"], "ref")),
            field("draft", if pr["draft"] == Value::Bool(true) { "true" } else { "false" }),
            field("url", s(pr, "html_url")),
            field("timestamp", s(pr, "created_at")),
        ],
    }
}

fn build_release(repo: &str, rel: &Value) -> Built {
    let published = s(rel, "published_at");
    Built {
        event: "github-release",
        branch: String::new(),
        fields: vec![
            field("repo", repo),
            field("tag", s(rel, "tag_name")),
            field("name", s(rel, "name")),
            field("body", body_text(rel, "body")),
            field("author", s(&rel["author"], "login")),
            field(
                "prerelease",
                if rel["prerelease"] == Value::Bool(true) { "true" } else { "false" },
            ),
            field("url", s(rel, "html_url")),
            field("timestamp", if published.is_empty() { s(rel, "created_at") } else { published }),
        ],
    }
}

fn build_star(repo: &str, star: &Value) -> Built {
    Built {
        event: "github-star",
        branch: String::new(),
        fields: vec![
            field("repo", repo),
            field("user", s(&star["user"], "login")),
            field("timestamp", s(star, "starred_at")),
        ],
    }
}

/// Stringify, and never trip `ingest_event`'s shape cap: the only unbounded
/// field is the issue/pr/release body, so re-slice that one rather than lose the
/// delivery.
fn dispatch_payload(built: &Built) -> String {
    let mut obj = J::O(built.fields.iter().map(|(k, v)| (k.clone(), clone_j(v))).collect());
    let payload = js::stringify(&obj);
    if payload.encode_utf16().count() <= MAX_EVENT_PAYLOAD {
        return payload;
    }
    if let J::O(fields) = &mut obj {
        if let Some((_, J::S(body))) = fields.iter_mut().find(|(k, _)| k == "body") {
            *body = utf16_prefix(body, GUARD_BODY_CHARS).unwrap_or_else(|| body.clone());
        }
    }
    js::stringify(&obj)
}

/// One canned API object per event, in the shape the REST endpoints hand back.
/// Production code, not `#[cfg(test)]`, because the designer sample is built
/// from it — and `the_five_parsers_produce_the_documented_payload` parses the
/// same objects, so the sample and the key-order spec are one input.
fn sample_item(event: &str) -> Value {
    match event {
        "github-issue" => json!({
            "number": 17,
            "title": "Crash when input is empty",
            "body": "Steps to reproduce: run with no arguments…",
            "user": { "login": "ada" },
            // the second label has no name: a malformed one is dropped, not ""
            "labels": [{ "name": "bug" }, { "id": 9 }],
            "html_url": "https://github.com/octocat/hello-world/issues/17",
            "created_at": "2026-07-18T12:34:56Z",
            "state": "open",
        }),
        "github-pr" => json!({
            "number": 42,
            "title": "Add retry logic to the fetcher",
            "body": "Retries transient failures up to 3 times.",
            "user": { "login": "ada" },
            "head": { "ref": "feature/retries" },
            "base": { "ref": "main" },
            "draft": false,
            "html_url": "https://github.com/octocat/hello-world/pull/42",
            "created_at": "2026-07-18T12:34:56Z",
        }),
        "github-release" => json!({
            "id": 148_038_732,
            "tag_name": "v1.2.0",
            "name": "1.2.0",
            "body": "Highlights: retry logic, faster startup.",
            "author": { "login": "ada" },
            "prerelease": false,
            "draft": false,
            "html_url": "https://github.com/octocat/hello-world/releases/tag/v1.2.0",
            "created_at": "2026-07-17T09:00:00Z",
            "published_at": "2026-07-18T12:34:56Z",
        }),
        "github-star" => json!({
            "starred_at": "2026-07-18T12:34:56Z",
            "user": { "login": "ada" },
        }),
        _ => Value::Null,
    }
}

/// The canned payload a designer test run seeds a `github-*` event node with
/// (`events::sample_payload`). `None` for anything this module does not build.
///
/// A push carries the unenriched shape: `pusher`/`commitCount`/`messages`/
/// `timestamp` are filled by `enrich_push`'s compare call, which a sample has
/// no network for — every key is still there, exactly as an unenrichable push
/// delivers them.
pub fn sample_payload(event: &str) -> Option<String> {
    let repo = "octocat/hello-world";
    let built = match event {
        "github-push" => build_push(
            repo,
            "main",
            "9b1d3f7e6a5c4d3b2a1f0e9d8c7b6a5f4e3d2c1b",
            "0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09",
        ),
        "github-issue" => build_issue(repo, &sample_item(event)),
        "github-pr" => build_pr(repo, &sample_item(event)),
        "github-release" => build_release(repo, &sample_item(event)),
        "github-star" => build_star(repo, &sample_item(event)),
        _ => return None,
    };
    Some(dispatch_payload(&built))
}

/// Which subs want a built event: event equality plus the optional push branch
/// filter. Ported from `subWantsEvent`. The watch key already encodes the
/// branch, so this is defense in depth — and it is what keeps a filter from ever
/// broadening delivery.
fn sub_wants_event(sub: &EventSubscription, built: &Built) -> bool {
    if sub.event != built.event {
        return false;
    }
    // the branch filter is a push-only config field; on any other event a stray
    // `branch` in the config must not filter anything out
    if built.event != "github-push" {
        return true;
    }
    match sub.config.get("branch") {
        Some(branch) if !branch.is_empty() => *branch == built.branch,
        _ => true,
    }
}

// --- cursors ----------------------------------------------------------------

/// Its own table, not the `registry_entry` config blob and not the workflow
/// graph: a cursor is keyed by (repo, resource, branch), which no registry entry
/// exists for, and writing one into the graph would rewrite the user's document
/// ~120 times an hour and race the designer's autosave.
fn init(store: &Store) -> rusqlite::Result<()> {
    store.conn().execute_batch(
        "create table if not exists github_cursor (
             id text primary key,
             cursor text not null,
             etag text not null default '',
             updated_at integer not null
         );",
    )
}

/// `(cursor, etag)`. A missing row is the baseline case — `None` means "record
/// the max and dispatch nothing", which is not the same as `Some("")`.
fn load_cursor(store: &Store, key: &str) -> (Option<String>, Option<String>) {
    let conn = store.conn();
    let row: rusqlite::Result<(String, String)> =
        conn.query_row("select cursor, etag from github_cursor where id = ?1", [key], |r| {
            Ok((r.get(0)?, r.get(1)?))
        });
    match row {
        Ok((cursor, etag)) => (Some(cursor), Some(etag).filter(|e| !e.is_empty())),
        Err(_) => (None, None),
    }
}

fn save_cursor(store: &Store, key: &str, cursor: &str, etag: &str) -> rusqlite::Result<()> {
    store.conn().execute(
        "insert into github_cursor (id, cursor, etag, updated_at) values (?1, ?2, ?3, ?4)
         on conflict(id) do update set cursor = ?2, etag = ?3, updated_at = ?4",
        rusqlite::params![key, cursor, etag, now_ms()],
    )?;
    Ok(())
}

// --- the response taxonomy --------------------------------------------------

struct Res {
    status: u16,
    headers: HeaderMap,
    body: String,
}

impl Res {
    fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Ok,
    NotModified,
    /// 401 — the PAT is bad or expired. Permanent until its value changes.
    Dead,
    /// 403/429 — sleeps the whole poller, because every watch shares one PAT's
    /// budget.
    RateLimited(Duration),
    /// 404/451 — repo missing, renamed away, blocked, or invisible to this
    /// token. NOT permanent: fixable outside Saturn.
    NotFound,
    /// 5xx, an unexpected status, a network failure, or an unparseable body.
    Backoff,
}

fn clamp_rate_sleep(ms: f64) -> Duration {
    let min = RATE_LIMIT_MIN_SLEEP.as_millis() as f64;
    let max = RATE_LIMIT_MAX_SLEEP.as_millis() as f64;
    Duration::from_millis(ms.clamp(min, max) as u64)
}

fn classify(res: &Res, now: i64) -> Outcome {
    match res.status {
        304 => Outcome::NotModified,
        401 => Outcome::Dead,
        403 | 429 => rate_limited(res, now),
        404 | 451 => Outcome::NotFound,
        200..=299 => Outcome::Ok,
        _ => Outcome::Backoff,
    }
}

fn rate_limited(res: &Res, now: i64) -> Outcome {
    // Retry-After (seconds) wins when present — that is what a secondary limit
    // sends. js::to_number, not str::parse: `Number("")` is 0 and `Number("x")`
    // is NaN, and both must fall through rather than become a sleep.
    let retry_after = js::to_number(res.header("retry-after"));
    if retry_after.is_finite() && retry_after > 0.0 {
        return Outcome::RateLimited(clamp_rate_sleep(retry_after * 1_000.0));
    }
    // primary limit: remaining 0 → sleep until the reset, +2s of slack
    let reset = js::to_number(res.header("x-ratelimit-reset"));
    if res.header("x-ratelimit-remaining") == "0" && reset.is_finite() {
        return Outcome::RateLimited(clamp_rate_sleep(reset * 1_000.0 - now as f64 + 2_000.0));
    }
    // other 403: permissions, or a secondary limit with no headers at all
    Outcome::Backoff
}

/// `X-Poll-Interval`, clamped into [POLL_S, MAX_POLL_S] so a bad header can
/// neither stall the loop nor make it hammer. Absent → keep the current cadence.
fn poll_interval(res: &Res, current: Duration) -> Duration {
    let raw = res.header("x-poll-interval");
    if raw.is_empty() {
        return current;
    }
    let n = js::to_number(raw);
    if !n.is_finite() {
        return current;
    }
    Duration::from_secs(n.clamp(POLL_S as f64, MAX_POLL_S as f64) as u64)
}

/// `Link: <…?page=7>; rel="last"` → 7. Stargazers list oldest-first, so the
/// newest are on the last page and there is no way to ask for them directly.
fn link_last_page(res: &Res) -> Option<u32> {
    let link = res.header("link");
    let last = link.split(',').find(|part| part.contains("rel=\"last\""))?;
    let url = last.split('<').nth(1)?.split('>').next()?;
    // split on the query separators and take the whole `page` param: a suffix
    // search would read `per_page=100` as the page number whenever GitHub
    // happens to order the query string the other way round.
    url.split(['?', '&']).find_map(|kv| kv.strip_prefix("page="))?.parse().ok()
}

// --- cursor application -----------------------------------------------------

/// Apply one fetched body to a cursor. Pure — the whole baseline/replay
/// discipline lives here, which is why it is testable without a socket. `now` is
/// a parameter for the same reason: `SKIP_OLDER_THAN_S` is part of that
/// discipline, and reaching for `now_ms()` in here would make it untestable.
///
/// `cursor == None` is the FIRST poll of this resource: record the current max
/// and dispatch nothing. Anything else replays the repo's history the first time
/// a workflow polls.
///
/// Four of the five resources are age-guarded here. Push is not: the refs
/// endpoint carries only a SHA, so its timestamp does not exist until
/// `enrich_push` runs — `poll_watch` applies `fresh_built` after that.
fn apply(
    resource: Resource,
    repo: &str,
    branch: &str,
    body: &Value,
    cursor: Option<&str>,
    now: i64,
) -> Result<(String, Vec<Built>), String> {
    match resource {
        Resource::Push => {
            let want = format!("refs/heads/{branch}");
            // The legacy refs endpoint prefix-matches, so it answers with an
            // array when several branches share the prefix ("main" also matches
            // "main-2"). Take the exact ref, never the first element.
            let sha = match body {
                Value::Array(items) => {
                    items.iter().find(|r| s(r, "ref") == want).map(|r| s(&r["object"], "sha"))
                }
                _ if s(body, "ref") == want => Some(s(&body["object"], "sha")),
                _ => None,
            };
            let sha = sha.filter(|sha| !sha.is_empty()).ok_or_else(|| format!("no {want}"))?;
            let Some(prev) = cursor else {
                return Ok((sha, Vec::new())); // baseline
            };
            if prev == sha {
                return Ok((sha, Vec::new()));
            }
            let built = build_push(repo, branch, prev, &sha);
            Ok((sha, vec![built]))
        }
        // Every `build` below returns None for a stale item, which is the same
        // door the PR-in-the-issues-feed filter uses: nothing is dispatched and
        // the cursor still advances past it.
        Resource::Issue => Ok(newest_first(
            arr(body),
            |item| item["number"].as_i64(),
            // the issues endpoint lists pull requests too (they share one number
            // sequence) — a github-issue node must not fire for a PR, but the
            // cursor still advances past it
            |item| {
                item.get("pull_request")
                    .is_none()
                    .then(|| build_issue(repo, item))
                    .filter(|b| fresh_built(b, now))
            },
            cursor,
        )),
        Resource::Pr => Ok(newest_first(
            arr(body),
            |item| item["number"].as_i64(),
            |item| Some(build_pr(repo, item)).filter(|b| fresh_built(b, now)),
            cursor,
        )),
        Resource::Release => Ok(newest_first(
            arr(body),
            // A PAT with push access sees drafts in this list, and the webhook
            // fired on `published` — which for the normal "Draft a new release"
            // flow happens LONG after the id was minted. So a draft must not be
            // acked: acking it puts its id under the cursor and the publish that
            // follows can then never be `id > cursor`, i.e. never fires at all.
            |item| (item["draft"] != Value::Bool(true)).then(|| item["id"].as_i64()).flatten(),
            |item| Some(build_release(repo, item)).filter(|b| fresh_built(b, now)),
            cursor,
        )),
        // stargazers come back oldest-first and the cursor is an RFC3339 UTC
        // timestamp, which orders lexicographically
        Resource::Star => {
            let mut max = cursor.unwrap_or("").to_string();
            let mut dispatch = Vec::new();
            for item in arr(body) {
                let at = s(item, "starred_at");
                if at.is_empty() {
                    continue;
                }
                // `max` is updated below whatever this decides, so a star
                // skipped for age is acked rather than re-seen every poll
                if cursor.is_some_and(|c| at.as_str() > c) && fresh(&at, now) {
                    dispatch.push(build_star(repo, item));
                }
                if at > max {
                    max = at;
                }
            }
            Ok((max, if cursor.is_none() { Vec::new() } else { dispatch }))
        }
    }
}

/// A newest-first list keyed by a monotonically increasing integer. The first
/// poll records the max and dispatches NOTHING; later polls dispatch everything
/// above the cursor, oldest-first.
///
/// The cursor advances over every item SEEN, even ones nothing is built for (a
/// PR in the issues feed, a draft release) — acking them is what stops a
/// permanently-filtered item from being re-examined on every poll forever.
fn newest_first(
    items: &[Value],
    key: impl Fn(&Value) -> Option<i64>,
    build: impl Fn(&Value) -> Option<Built>,
    cursor: Option<&str>,
) -> (String, Vec<Built>) {
    let base = cursor.and_then(|c| c.parse::<i64>().ok());
    let mut max = base.unwrap_or(0);
    let mut dispatch = Vec::new();
    for item in items {
        let Some(k) = key(item) else {
            continue; // malformed id — skipped, and never acked
        };
        if base.is_some_and(|b| k > b) {
            if let Some(built) = build(item) {
                dispatch.push(built);
            }
        }
        if k > max {
            max = k;
        }
    }
    dispatch.reverse(); // newest-first → oldest-first
    (max.to_string(), if base.is_none() { Vec::new() } else { dispatch })
}

// --- the poller -------------------------------------------------------------

/// One watched (repo, resource, branch). Many workflows and event nodes can
/// watch the same one — they share a fetch, an ETag and a cursor, and every
/// built event fans out over the subs that want it.
struct Watch {
    key: String,
    repo: String, // original casing, for the URL; the key lower-cases it
    resource: Resource,
    branch: String, // push only; "" = the repo's default branch
    subs: Vec<EventSubscription>,
}

#[derive(Default)]
struct WatchState {
    retry_at: Option<Instant>,
    backoff: Option<Duration>,
}

struct Poller {
    watches: Vec<Watch>,
    state: HashMap<String, WatchState>,
    default_branch: HashMap<String, String>,
    interval: Duration,
    /// Rate limits are per-PAT, so one 403 pauses every watch — sleeping only
    /// the one that hit it would spend the remaining budget on the others and
    /// keep the limit pinned.
    resume_at: Option<Instant>,
    /// The token value a 401 (or a charset rejection) killed. Cleared when the
    /// stored PAT changes, which is the only thing that can fix it.
    dead_token: Option<String>,
    /// Whether the "star needs a PAT" line has been printed for the current
    /// no-token state. The pass runs every 30s and would otherwise log it
    /// forever; re-armed the moment a PAT appears, so removing one warns again.
    star_warned: bool,
}

fn tag(watch: &Watch) -> String {
    if watch.branch.is_empty() {
        format!("{} {}", watch.repo, watch.resource.as_str())
    } else {
        format!("{} {} {}", watch.repo, watch.resource.as_str(), watch.branch)
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(FETCH_TIMEOUT)
        // GitHub 301s a renamed repo, and the Authorization header must not
        // follow that anywhere but api.github.com. An explicit policy rather
        // than relying on reqwest's cross-host header stripping, because the
        // guard is the point and this way it is visible.
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || attempt.url().host_str() != Some(API_HOST) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn request(
    client: &Client,
    url: &str,
    token: &str,
    accept: &str,
    etag: Option<&str>,
    timeout: Duration,
) -> Result<Res, String> {
    let mut req = client
        .get(url)
        .timeout(timeout)
        .header("user-agent", USER_AGENT)
        .header("accept", accept)
        .header("x-github-api-version", GITHUB_API_VERSION);
    if !token.is_empty() {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    if let Some(etag) = etag {
        req = req.header("if-none-match", etag);
    }
    // net_error, never e.to_string(): reqwest's Display appends " for url (…)",
    // and a request URL must never be echoed back into a log line.
    let res = req.send().map_err(crate::http::net_error)?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().map_err(crate::http::net_error)?;
    Ok(Res { status, headers, body })
}

/// Hands one built event to the dispatch spine. Fire-and-forget on its own std
/// thread: `ingest_event` executes the whole workflow inline, and the poll pass
/// must never block on a run (nor build a blocking client on a runtime worker).
fn deliver(app: &AppHandle, store: &Store, sub: &EventSubscription, payload: String, tag: String) {
    let (app, store) = (app.clone(), store.clone());
    let (workflow_id, node_id) = (sub.workflow_id.clone(), sub.node_id.clone());
    // `spawn_blocking`, matching the Discord and Telegram transports: a raw
    // `thread::spawn` is unbounded and *panics* if the OS refuses the thread, and
    // that panic lands in `cycle` and takes the poller down. One wake-from-sleep
    // pass can deliver a full stargazer page, and every `ingest_event` runs a whole
    // workflow that builds its own blocking client — 100 stars was ~200 threads all
    // contending on the single `Store` mutex.
    tauri::async_runtime::spawn_blocking(move || {
        match events::ingest_event(Some(&app), &store, &KEYCHAIN, &workflow_id, &node_id, &payload) {
            Ok(result) => println!("[github {tag}] delivered to workflow {workflow_id}: {result:?}"),
            Err(err) => {
                eprintln!("[github {tag}] delivery failed for workflow {workflow_id}: {err}")
            }
        }
    });
}

impl Poller {
    fn new() -> Poller {
        Poller {
            watches: Vec::new(),
            state: HashMap::new(),
            default_branch: HashMap::new(),
            interval: Duration::from_secs(POLL_S),
            resume_at: None,
            dead_token: None,
            star_warned: false,
        }
    }

    fn retry_in(&mut self, key: &str, delay: Duration) {
        self.state.entry(key.to_string()).or_default().retry_at = Some(Instant::now() + delay);
    }

    /// Exponential backoff, doubling to a one-minute ceiling.
    fn backoff(&mut self, key: &str) {
        let st = self.state.entry(key.to_string()).or_default();
        let delay = st.backoff.unwrap_or(FIRST_BACKOFF);
        st.backoff = Some((delay * 2).min(MAX_BACKOFF));
        st.retry_at = Some(Instant::now() + delay);
    }

    fn clear_backoff(&mut self, key: &str) {
        if let Some(st) = self.state.get_mut(key) {
            st.backoff = None;
            st.retry_at = None;
        }
    }

    /// Rebuild the work list. A read failure KEEPS the current watches — an
    /// empty feed means "stop watching everything", and a transient DB error
    /// must not be read as one.
    fn reconcile(&mut self, store: &Store, vault: &dyn Vault) {
        let subs = match events::get_event_subscriptions(store, vault) {
            Ok(subs) => subs,
            Err(err) => {
                eprintln!("[github] subscription query failed: {err}");
                return;
            }
        };
        let mut by_key: HashMap<String, Watch> = HashMap::new();
        for sub in subs.into_iter().filter(|s| s.provider == "github") {
            let repo = js::trim(sub.config.get("repo").map_or("", String::as_str)).to_string();
            if !valid_repo(&repo) {
                eprintln!(
                    "[github] skipping subscription for workflow {}: invalid repository ({})",
                    sub.workflow_id,
                    // fingerprinted, not echoed: `effective_event_config` resolves a
                    // value edge into ANY config field, so a secret variable wired to
                    // `repo` arrives here as plaintext — and it will never be valid,
                    // so the invalid branch is exactly where it would print in full.
                    events::fp(&repo),
                );
                continue;
            }
            let Some(resource) = Resource::from_event(&sub.event) else {
                continue;
            };
            let branch = js::trim(sub.config.get("branch").map_or("", String::as_str)).to_string();
            if resource == Resource::Push && !branch.is_empty() && !valid_branch(&branch) {
                eprintln!(
                    "[github {}] skipping subscription for workflow {}: invalid branch ({})",
                    events::fp(&repo),
                    sub.workflow_id,
                    events::fp(&branch),
                );
                continue;
            }
            let branch = if resource == Resource::Push { branch } else { String::new() };
            let key = format!("{}\n{}\n{branch}", repo.to_lowercase(), resource.as_str());
            by_key
                .entry(key.clone())
                .or_insert_with(|| Watch { key, repo, resource, branch, subs: Vec::new() })
                .subs
                .push(sub);
        }
        // a watch that is gone takes its 404 timer and backoff ladder with it;
        // its cursor row stays, so re-adding the workflow does not re-baseline
        self.state.retain(|key, _| by_key.contains_key(key));
        self.watches = by_key.into_values().collect();
    }

    /// The repo's default branch, for a push node with no branch filter. Cached
    /// for the life of the process; re-resolving after a restart costs one
    /// request, and the cursor is keyed by the empty filter, so a default-branch
    /// rename does not re-baseline.
    /// `Err` carries the same taxonomy the watch fetch uses, so a lookup that
    /// 404s parks the watch for 15 min like any other inaccessible repo. Feeding
    /// it into the exponential ladder instead re-asked ~60×/hr, and this call is
    /// unconditional (no ETag), so it burned the whole 60 req/hr unauthenticated
    /// budget and dragged every other watch into the shared rate-limit pause.
    fn resolve_default_branch(
        &mut self,
        client: &Client,
        token: &str,
        repo: &str,
    ) -> Result<String, Outcome> {
        let cache_key = repo.to_lowercase();
        if let Some(branch) = self.default_branch.get(&cache_key) {
            return Ok(branch.clone());
        }
        let url = format!("{API_BASE}/repos/{repo}");
        let res = match request(client, &url, token, GITHUB_ACCEPT, None, FETCH_TIMEOUT) {
            Ok(res) if res.status == 200 => res,
            Ok(res) => {
                eprintln!("[github {repo}] default branch lookup failed ({})", res.status);
                return Err(classify(&res, now_ms()));
            }
            Err(err) => {
                eprintln!("[github {repo}] default branch lookup failed: {err}");
                return Err(Outcome::Backoff);
            }
        };
        let branch = serde_json::from_str::<Value>(&res.body)
            .ok()
            .map(|v| s(&v, "default_branch"))
            .filter(|b| valid_branch(b))
            .ok_or(Outcome::Backoff)?;
        self.default_branch.insert(cache_key, branch.clone());
        Ok(branch)
    }

    fn poll_watch(&mut self, app: &AppHandle, store: &Store, client: &Client, token: &str, index: usize) {
        let (key, repo, resource, filter, tag) = {
            let w = &self.watches[index];
            (w.key.clone(), w.repo.clone(), w.resource, w.branch.clone(), tag(w))
        };
        let branch = if resource == Resource::Push && filter.is_empty() {
            match self.resolve_default_branch(client, token, &repo) {
                Ok(branch) => branch,
                Err(Outcome::NotFound) => return self.retry_in(&key, NOT_FOUND_RETRY),
                Err(Outcome::RateLimited(delay)) => {
                    self.resume_at = Some(Instant::now() + delay);
                    return;
                }
                Err(Outcome::Dead) => {
                    self.tombstone(token);
                    return;
                }
                Err(_) => return self.backoff(&key),
            }
        } else {
            filter
        };

        let (cursor, etag) = load_cursor(store, &key);
        let url = format!("{API_BASE}{}", resource.path(&repo, &branch));
        // Stargazers: page 1 holds the OLDEST stars and never changes, so a
        // conditional GET there would 304 forever while new stars land on the
        // last page. Page 1 is unconditional; only the last-page fetch carries
        // the ETag, which is why a star watch costs one request per poll.
        let star = resource == Resource::Star;
        let mut res = match request(
            client,
            &url,
            token,
            resource.accept(),
            if star { None } else { etag.as_deref() },
            FETCH_TIMEOUT,
        ) {
            Ok(res) => res,
            Err(err) => {
                eprintln!("[github {tag}] fetch failed: {err}");
                return self.backoff(&key);
            }
        };
        if star && res.status == 200 {
            if let Some(page) = link_last_page(&res).filter(|p| *p > 1) {
                let paged = format!("{url}&page={page}");
                match request(client, &paged, token, STAR_ACCEPT, etag.as_deref(), FETCH_TIMEOUT) {
                    Ok(last) => res = last,
                    Err(err) => {
                        eprintln!("[github {tag}] fetch failed: {err}");
                        return self.backoff(&key);
                    }
                }
            }
        }

        self.interval = poll_interval(&res, self.interval);
        // A completed poll is not due again until the cadence elapses (the
        // failure arms below set their own, longer, retry). Without it every
        // `subscriptions_changed()` wake (2s debounce) ran a full pass over
        // every watch, ignoring `interval` entirely — free for the conditional
        // GETs, but a star watch's page-1 fetch is unconditional by design and
        // would eat the 60 req/hr unauthenticated budget in a minute.
        let due = self.interval;
        let now = now_ms();
        match classify(&res, now) {
            // no new data, no quota spent
            Outcome::NotModified => {
                self.clear_backoff(&key);
                self.retry_in(&key, due);
            }
            Outcome::Dead => {
                eprintln!(
                    "[github {tag}] giving up: authentication failed{} — check the access token \
                     (a fine-grained PAT with read access)",
                    if token.is_empty() { String::new() } else { format!(" for {}", events::fp(token)) },
                );
                self.tombstone(token);
            }
            Outcome::RateLimited(delay) => {
                eprintln!(
                    "[github {tag}] rate limited — waiting {}s for reset; a fine-grained PAT \
                     raises the limit to 5000/hr",
                    delay.as_secs(),
                );
                self.resume_at = Some(Instant::now() + delay);
            }
            Outcome::NotFound => {
                eprintln!(
                    "[github {tag}] repo not accessible ({}) — check that {repo} exists and the \
                     token (if any) can read it; retrying in 15 min",
                    res.status,
                );
                self.retry_in(&key, NOT_FOUND_RETRY);
            }
            Outcome::Backoff => {
                eprintln!(
                    "[github {tag}] fetch failed ({}): {}",
                    res.status,
                    utf16_prefix(&res.body, 200).unwrap_or_else(|| res.body.clone()),
                );
                self.backoff(&key);
            }
            Outcome::Ok => {
                let parsed = serde_json::from_str::<Value>(&res.body)
                    .map_err(|e| e.to_string())
                    .and_then(|body| apply(resource, &repo, &branch, &body, cursor.as_deref(), now));
                let (next, mut built) = match parsed {
                    Ok(out) => out,
                    Err(err) => {
                        eprintln!("[github {tag}] could not parse the response: {err}");
                        return self.backoff(&key);
                    }
                };
                self.clear_backoff(&key);
                self.retry_in(&key, due);
                // The cursor is written BEFORE dispatch, so a crash mid-run
                // cannot re-deliver on the next launch. A run that dies takes its
                // event with it; the alternative replays it every launch.
                // `this.etag = res.headers.get("etag") ?? this.etag` — a response
                // without the header KEEPS the stored one. Writing "" through
                // would drop the conditional request and start spending quota.
                let fresh_etag = res.header("etag");
                let keep = etag.as_deref().unwrap_or("");
                let next_etag = if fresh_etag.is_empty() { keep } else { fresh_etag };
                if let Err(err) = save_cursor(store, &key, &next, next_etag) {
                    eprintln!("[github {tag}] could not persist the cursor: {err}");
                }
                for item in built.iter_mut().filter(|b| b.event == "github-push") {
                    enrich_push(client, token, &repo, item);
                }
                // The other four were age-guarded inside `apply`; a push has no
                // timestamp until the compare call above supplies one, so its
                // half of the guard runs here. The cursor was written before
                // either — a skipped event is acked, never re-examined.
                built.retain(|b| fresh_built(b, now));
                for item in &built {
                    let payload = dispatch_payload(item);
                    for sub in self.watches[index].subs.iter().filter(|s| sub_wants_event(s, item)) {
                        deliver(app, store, sub, payload.clone(), tag.clone());
                    }
                }
            }
        }
    }

    /// Retires a token permanently — a 401 will not fix itself, so retrying only
    /// spends the budget. The empty-token guard matters: `cycle` compares
    /// `dead_token == Some(token)`, and with no PAT configured that comparison is
    /// `Some("") == Some("")`, which would tombstone *every* watch while
    /// `has_github_pat()` still reported false, so the UI would show nothing wrong.
    /// Unauthenticated 401s are also the case where the fix is "set a PAT", not
    /// "stop polling".
    fn tombstone(&mut self, token: &str) {
        if !token.is_empty() {
            self.dead_token = Some(token.to_string());
        }
    }

    /// One reconcile plus one pass over every due watch. Blocking end to end
    /// (SQLite, the Keychain, the HTTP calls), so it only ever runs under
    /// `spawn_blocking`.
    fn cycle(&mut self, app: &AppHandle) {
        let store = app.state::<Store>().inner().clone();
        if let Err(err) = init(&store) {
            eprintln!("[github] cursor table unavailable: {err}");
            return;
        }
        self.reconcile(&store, &KEYCHAIN);
        if self.watches.is_empty() {
            return; // nothing watches GitHub — don't even reach for the Keychain
        }
        if self.resume_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        self.resume_at = None;

        let token =
            js::trim(&secrets::get(&KEYCHAIN, &Secret::GithubPat).unwrap_or_default()).to_string();
        // re-arm the once-per-state-change star warning as soon as a PAT exists
        self.star_warned &= token.is_empty();
        if self.dead_token.as_deref() == Some(token.as_str()) {
            return; // 401 tombstone — only a different token value revives it
        }
        self.dead_token = None;
        // A malformed token is a 401 that has not happened yet: polling with
        // garbage spends the unauthenticated budget and fails every private
        // repo, so treat it as one — dead until the value changes.
        if !token.is_empty() && !valid_token(&token) {
            eprintln!("[github] access token is malformed ({}) — not polling", events::fp(&token));
            self.dead_token = Some(token);
            return;
        }
        let client = match client() {
            Ok(client) => client,
            Err(err) => return eprintln!("[github] http client: {err}"),
        };

        let now = Instant::now();
        for index in 0..self.watches.len() {
            let key = self.watches[index].key.clone();
            if self.state.get(&key).and_then(|s| s.retry_at).is_some_and(|at| now < at) {
                continue;
            }
            // a star watch with no PAT would burn the anonymous budget and park
            // every other watch — logged once, not once per 30s pass
            if !self.watches[index].resource.pollable(&token) {
                if !self.star_warned {
                    self.star_warned = true;
                    eprintln!(
                        "[github] github-star needs an access token — not polling it (unauthenticated it would spend the whole 60/hr budget and stall every other watch); add one in settings"
                    );
                }
                continue;
            }
            self.poll_watch(app, &store, &client, &token, index);
            // a rate limit and a dead token are both global: stop the pass
            // rather than spending it collecting the same failure five times
            if self.resume_at.is_some() || self.dead_token.is_some() {
                return;
            }
        }
    }
}

/// The refs endpoint carries only the head SHA, so commitCount / messages /
/// pusher / timestamp come from one compare call per push. Best effort by
/// design: a 404 after a force push, a timeout, or a parse failure leaves the
/// defaults in place — a delivery must never be dropped because the enrichment
/// failed.
fn enrich_push(client: &Client, token: &str, repo: &str, built: &mut Built) {
    let before = text(&built.fields, "beforeSha");
    let head = text(&built.fields, "headSha");
    if !valid_sha(&before) || !valid_sha(&head) {
        return;
    }
    let url = format!("{API_BASE}/repos/{repo}/compare/{before}...{head}");
    let Ok(res) = request(client, &url, token, GITHUB_ACCEPT, None, ENRICH_TIMEOUT) else {
        return;
    };
    if res.status != 200 {
        return;
    }
    let Ok(cmp) = serde_json::from_str::<Value>(&res.body) else {
        return;
    };
    let commits = arr(&cmp["commits"]);
    let mut set = |key: &str, value: J| {
        if let Some(slot) = built.fields.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        }
    };
    if let Some(total) = cmp["total_commits"].as_i64() {
        set("commitCount", J::S(total.to_string()));
    }
    set(
        "messages",
        strings(
            commits
                .iter()
                .take(MAX_COMMIT_MESSAGES)
                .map(|c| {
                    let msg = s(&c["commit"], "message");
                    utf16_prefix(&msg, MAX_COMMIT_MESSAGE_CHARS).unwrap_or(msg)
                })
                .collect(),
        ),
    );
    // the head commit stands in for the webhook's actor and created_at, which
    // the refs endpoint has no equivalent of
    if let Some(head) = commits.last() {
        set("pusher", J::S(s(&head["author"], "login")));
        let committed = s(&head["commit"]["committer"], "date");
        let authored = s(&head["commit"]["author"], "date");
        set("timestamp", J::S(if committed.is_empty() { authored } else { committed }));
    }
}

/// Starts the poller. One tokio task, polling every watch in sequence, because
/// they all share one PAT's rate-limit budget — the per-poller tasks the
/// TypeScript spawned existed to isolate per-token quotas, and there is exactly
/// one token now.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // created ONCE, before the first read: a watch receiver only sees
        // changes published after it exists, so subscribing inside the loop
        // would drop every mutation that lands during a pass
        let mut changed = events::on_subscriptions_changed();
        let mut poller = Poller::new();
        println!("[github] started (polling every {POLL_S}s)");
        loop {
            let handle = app.clone();
            // the pass is blocking end to end and must not sit on a runtime
            // worker; the state moves in and comes back out because a borrow
            // cannot cross spawn_blocking
            poller = match tauri::async_runtime::spawn_blocking(move || {
                poller.cycle(&handle);
                poller
            })
            .await
            {
                Ok(poller) => poller,
                // A panicked pass must not silently end GitHub polling for the
                // life of the app — `deliver`'s thread spawn, a poisoned lock or
                // any future `unwrap` in `cycle` would do exactly that. The
                // other two transports log and keep looping; so does this one,
                // with a fresh Poller (the old one was moved into the panic).
                Err(err) => {
                    eprintln!("[github] poll pass panicked, restarting: {err}");
                    Poller::new()
                }
            };
            let wait = poller.interval;
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = changed.changed() => tokio::time::sleep(REFRESH_DEBOUNCE).await,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderName, HeaderValue};
    use serde_json::json;

    /// A 401 with no PAT set must not retire the empty token: `cycle` skips a
    /// watch when `dead_token == Some(token)`, so tombstoning `""` would stop
    /// every GitHub watch in the app while the settings UI still reported no PAT
    /// configured — nothing would look wrong and nothing would ever fire again.
    #[test]
    fn an_unauthenticated_401_does_not_tombstone_every_watch() {
        let mut p = Poller::new();
        p.tombstone("");
        assert_eq!(p.dead_token, None, "the empty token must stay pollable");

        p.tombstone("ghp_realtoken");
        assert_eq!(p.dead_token.as_deref(), Some("ghp_realtoken"));
    }

    /// `cycle` skips a watch whose resource is not `pollable` with the current
    /// token, and stars are the only resource that ever isn't: page 1 of
    /// `/stargazers` is fetched with no ETag (see `poll_watch`), so one
    /// unauthenticated star watch spends ~120 requests/hour against a 60/hour
    /// budget, and the 403 parks every other watch through the global
    /// `resume_at` — during which `SKIP_OLDER_THAN_S` drops their events
    /// outright. The other four are conditional and free either way.
    #[test]
    fn star_watches_are_not_polled_without_a_token() {
        assert!(!Resource::Star.pollable(""), "would burn the whole anonymous budget");
        assert!(Resource::Star.pollable("ghp_0123456789abcdefghij"));
        for resource in [Resource::Push, Resource::Issue, Resource::Pr, Resource::Release] {
            assert!(resource.pollable(""), "{} polls fine unauthenticated", resource.as_str());
        }
    }

    /// The fixture clock: one minute after the `2026-07-18T12:34:56Z` the
    /// payload fixtures carry, so the age guard passes everywhere and those
    /// assertions stay about payload shape. Real time would make them expire.
    fn now() -> i64 {
        parse_utc_ms("2026-07-18T12:35:56Z").unwrap()
    }

    fn res(status: u16, headers: &[(&str, &str)], body: &str) -> Res {
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            map.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        Res { status, headers: map, body: body.to_string() }
    }

    /// `repo` and `branch` are spliced into a URL path, so this is the SSRF
    /// guard. Every rejection below is a request that would otherwise have gone
    /// somewhere other than the repo the user named.
    #[test]
    fn the_path_validators_reject_hostile_input() {
        assert!(valid_repo("octocat/hello-world"));
        assert!(valid_repo("a/b"));
        assert!(valid_repo("o.rg/re.po-1_2"));

        assert!(!valid_repo("../../etc/passwd"));
        assert!(!valid_repo("octocat/../../secrets"));
        assert!(!valid_repo("octocat/.."), "a bare .. segment escapes the repo");
        assert!(!valid_repo("../hello"));
        assert!(!valid_repo("./hello"));
        assert!(!valid_repo("octocat/hello/world"), "a second slash is a different endpoint");
        assert!(!valid_repo("octocat%2f..%2fadmin"));
        assert!(!valid_repo("octocat/hello?x=1"));
        assert!(!valid_repo("octocat/hello#frag"));
        assert!(!valid_repo("octocat/hello world"));
        assert!(!valid_repo("octocat/hello\r\nx: y"));
        assert!(!valid_repo("octocat"));
        assert!(!valid_repo("/hello"));
        assert!(!valid_repo("octocat/"));
        assert!(!valid_repo(""));
        assert!(!valid_repo(&format!("{}/repo", "o".repeat(61))));
        assert!(!valid_repo(&format!("owner/{}", "r".repeat(121))));

        // branches legitimately contain "/", so the guard runs per segment
        assert!(valid_branch("main"));
        assert!(valid_branch("feature/retries"));
        assert!(valid_branch("release-1.2.x"));
        assert!(!valid_branch("../main"));
        assert!(!valid_branch("feature/../../main"));
        assert!(!valid_branch("feature/.."));
        assert!(!valid_branch("/main"));
        assert!(!valid_branch("main/"));
        assert!(!valid_branch("a//b"));
        assert!(!valid_branch("main?x=1"));
        assert!(!valid_branch("main#f"));
        assert!(!valid_branch("main%2f.."));
        assert!(!valid_branch("main branch"));
        assert!(!valid_branch(""));
        assert!(!valid_branch(&"b".repeat(256)));

        // the token only ever rides in a header, but a sentinel left literal in
        // the field must never travel as one
        assert!(valid_token(&format!("github_pat_{}", "A1b2".repeat(20))));
        assert!(valid_token("ghp_0123456789abcdefghij"));
        assert!(!valid_token("{{var:3f1a2b4c-0000-4000-8000-000000000001}}"));
        assert!(!valid_token("short"));
        assert!(!valid_token("has spaces in it here"));
        assert!(!valid_token("has\r\nCRLF\r\ninjection!!"));
        assert!(!valid_token(""));

        assert!(valid_sha("0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09"));
        assert!(valid_sha("0f7a2c9"));
        assert!(!valid_sha("0F7A2C9"), "uppercase would still be a different path");
        assert!(!valid_sha("0f7a2c"));
        assert!(!valid_sha("0f7a2c9...master"));
    }

    /// The payload shape every existing workflow destructures. Field order is
    /// observable — the `payload` port hands the graph this exact string — so
    /// these are compared whole, not field by field.
    #[test]
    fn the_five_parsers_produce_the_documented_payload() {
        // --- push: /git/refs/heads/main, the single-object form ---------------
        let refs = json!({
            "ref": "refs/heads/main",
            "object": { "sha": "0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09", "type": "commit" },
        });
        let prev = "9b1d3f7e6a5c4d3b2a1f0e9d8c7b6a5f4e3d2c1b";
        let (cursor, built) =
            apply(Resource::Push, "octocat/hello-world", "main", &refs, Some(prev), now()).unwrap();
        assert_eq!(cursor, "0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09");
        assert_eq!(
            dispatch_payload(&built[0]),
            r#"{"repo":"octocat/hello-world","ref":"refs/heads/main","branch":"main","pusher":"","commitCount":"0","headSha":"0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09","beforeSha":"9b1d3f7e6a5c4d3b2a1f0e9d8c7b6a5f4e3d2c1b","messages":[],"compareUrl":"https://github.com/octocat/hello-world/compare/9b1d3f7e6a5c4d3b2a1f0e9d8c7b6a5f4e3d2c1b...0f7a2c9e5c8d4b1a9e3f6d2c8b7a5e4d3c2b1a09","timestamp":""}"#
        );
        // the designer's sample is this same builder over the same input, so
        // every exact-string assert in this test pins the sample too
        assert_eq!(sample_payload("github-push"), Some(dispatch_payload(&built[0])));
        // the legacy refs endpoint prefix-matches: "main" also returns "main-2",
        // and taking the first element would track the wrong branch forever
        let prefix_match = json!([
            { "ref": "refs/heads/main-2", "object": { "sha": "1111111111111111111111111111111111111111" } },
            { "ref": "refs/heads/main", "object": { "sha": "2222222222222222222222222222222222222222" } },
        ]);
        let (cursor, _) = apply(Resource::Push, "o/r", "main", &prefix_match, Some(prev), now()).unwrap();
        assert_eq!(cursor, "2222222222222222222222222222222222222222");
        // a branch that is not in the response at all is a shape error, not a
        // silent no-op that would strand the cursor
        assert!(apply(Resource::Push, "o/r", "nope", &prefix_match, Some(prev), now()).is_err());

        // --- issue: GET /issues?sort=created&direction=desc -------------------
        // the four list feeds are the same canned objects the designer sample is
        // built from, so `sample_payload` is pinned by these asserts too
        let issues = json!([sample_item("github-issue")]);
        let (cursor, built) =
            apply(Resource::Issue, "octocat/hello-world", "", &issues, Some("16"), now()).unwrap();
        assert_eq!(cursor, "17");
        assert_eq!(
            dispatch_payload(&built[0]),
            r#"{"repo":"octocat/hello-world","number":"17","title":"Crash when input is empty","body":"Steps to reproduce: run with no arguments…","author":"ada","labels":["bug"],"url":"https://github.com/octocat/hello-world/issues/17","timestamp":"2026-07-18T12:34:56Z"}"#
        );
        assert_eq!(sample_payload("github-issue"), Some(dispatch_payload(&built[0])));
        // the issues endpoint lists pull requests too — a github-issue node must
        // not fire for one, but the cursor still has to advance past it
        let with_pr = json!([
            { "number": 18, "title": "a PR", "pull_request": { "url": "…" }, "user": {} },
            { "number": 17, "title": "an issue", "user": { "login": "ada" } },
        ]);
        let (cursor, built) = apply(Resource::Issue, "o/r", "", &with_pr, Some("16"), now()).unwrap();
        assert_eq!(cursor, "18", "the cursor must ack the PR it filtered out");
        assert_eq!(built.len(), 1);
        assert_eq!(text(&built[0].fields, "title"), "an issue");

        // --- pr: GET /pulls?sort=created&direction=desc&state=all -------------
        let pulls = json!([sample_item("github-pr")]);
        let (_, built) = apply(Resource::Pr, "octocat/hello-world", "", &pulls, Some("41"), now()).unwrap();
        assert_eq!(
            dispatch_payload(&built[0]),
            r#"{"repo":"octocat/hello-world","number":"42","title":"Add retry logic to the fetcher","body":"Retries transient failures up to 3 times.","author":"ada","sourceBranch":"feature/retries","targetBranch":"main","draft":"false","url":"https://github.com/octocat/hello-world/pull/42","timestamp":"2026-07-18T12:34:56Z"}"#
        );
        assert_eq!(sample_payload("github-pr"), Some(dispatch_payload(&built[0])));

        // --- release: GET /releases?per_page=1 --------------------------------
        let releases = json!([sample_item("github-release")]);
        let (cursor, built) =
            apply(Resource::Release, "octocat/hello-world", "", &releases, Some("148038731"), now()).unwrap();
        assert_eq!(cursor, "148038732");
        assert_eq!(
            dispatch_payload(&built[0]),
            r#"{"repo":"octocat/hello-world","tag":"v1.2.0","name":"1.2.0","body":"Highlights: retry logic, faster startup.","author":"ada","prerelease":"false","url":"https://github.com/octocat/hello-world/releases/tag/v1.2.0","timestamp":"2026-07-18T12:34:56Z"}"#
        );
        assert_eq!(sample_payload("github-release"), Some(dispatch_payload(&built[0])));
        // A draft dispatches nothing AND must not be acked. The webhook fired on
        // `action === "published"`, and "Draft a new release" mints the id long
        // before the publish — so acking the draft here would put its id under
        // the cursor and the publish could never satisfy `id > cursor`.
        let drafts = json!([{ "id": 148_038_733, "tag_name": "v1.3.0", "draft": true }]);
        let (cursor, built) = apply(Resource::Release, "o/r", "", &drafts, Some("148038732"), now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("148038732", 0), "a draft must not be acked");
        // …and publishing that same draft, id unchanged, now fires
        let published = json!([{
            "id": 148_038_733, "tag_name": "v1.3.0", "draft": false,
            "published_at": "2026-07-19T09:00:00Z",
        }]);
        let (cursor, built) = apply(Resource::Release, "o/r", "", &published, Some(&cursor), now()).unwrap();
        assert_eq!(cursor, "148038733");
        assert_eq!(built.len(), 1, "publishing a draft must fire github-release");
        assert_eq!(text(&built[0].fields, "tag"), "v1.3.0");

        // --- star: GET /stargazers, last page, star+json ----------------------
        let stars = json!([
            { "starred_at": "2026-07-18T12:00:00Z", "user": { "login": "grace" } },
            sample_item("github-star"),
        ]);
        let (cursor, built) =
            apply(Resource::Star, "octocat/hello-world", "", &stars, Some("2026-07-18T12:00:00Z"), now())
                .unwrap();
        assert_eq!(cursor, "2026-07-18T12:34:56Z");
        assert_eq!(built.len(), 1, "the star at the cursor must not re-deliver");
        assert_eq!(
            dispatch_payload(&built[0]),
            r#"{"repo":"octocat/hello-world","user":"ada","timestamp":"2026-07-18T12:34:56Z"}"#
        );
        assert_eq!(sample_payload("github-star"), Some(dispatch_payload(&built[0])));

        // an oversized body is re-sliced, never dropped: the delivery has to
        // survive ingest_event's MAX_EVENT_PAYLOAD check
        let huge = json!([{ "number": 1, "body": "x".repeat(MAX_EVENT_PAYLOAD * 2) }]);
        let (_, built) = apply(Resource::Issue, "o/r", "", &huge, Some("0"), now()).unwrap();
        let out = dispatch_payload(&built[0]);
        assert!(out.encode_utf16().count() <= MAX_EVENT_PAYLOAD, "{}", out.len());
        assert!(out.contains(&"x".repeat(GUARD_BODY_CHARS)));
    }

    /// The single most important behaviour in the module: saving a workflow must
    /// not replay the repo's history, and the poll after that must deliver every
    /// new item exactly once, oldest-first.
    #[test]
    fn the_first_poll_baselines_and_the_second_only_dispatches_what_is_new() {
        let feed = |numbers: &[i64]| -> Value {
            Value::Array(
                numbers
                    .iter()
                    .map(|n| json!({ "number": n, "title": format!("issue {n}"), "user": {} }))
                    .collect(),
            )
        };

        // first poll: a page of history, nothing dispatched
        let (cursor, built) = apply(Resource::Issue, "o/r", "", &feed(&[17, 16, 15]), None, now()).unwrap();
        assert_eq!(cursor, "17");
        assert!(built.is_empty(), "the baseline poll replayed history");

        // nothing new
        let (cursor, built) =
            apply(Resource::Issue, "o/r", "", &feed(&[17, 16, 15]), Some(&cursor), now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("17", 0));

        // two new issues, delivered oldest-first
        let (cursor, built) =
            apply(Resource::Issue, "o/r", "", &feed(&[19, 18, 17, 16]), Some(&cursor), now()).unwrap();
        assert_eq!(cursor, "19");
        let titles: Vec<String> = built.iter().map(|b| text(&b.fields, "title")).collect();
        assert_eq!(titles, ["issue 18", "issue 19"], "GitHub lists newest-first, we deliver oldest-first");

        // …and they are not delivered twice
        let (_, built) = apply(Resource::Issue, "o/r", "", &feed(&[19, 18]), Some(&cursor), now()).unwrap();
        assert!(built.is_empty());

        // an empty first page baselines at 0 rather than replaying later
        let (cursor, built) = apply(Resource::Pr, "o/r", "", &json!([]), None, now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("0", 0));

        // push and star baseline the same way
        let refs = json!({ "ref": "refs/heads/main", "object": { "sha": "aaaaaaa" } });
        let (cursor, built) = apply(Resource::Push, "o/r", "main", &refs, None, now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("aaaaaaa", 0));
        let (_, built) = apply(Resource::Push, "o/r", "main", &refs, Some(&cursor), now()).unwrap();
        assert!(built.is_empty(), "an unchanged head must not re-deliver");
        let stars = json!([{ "starred_at": "2026-01-01T00:00:00Z", "user": { "login": "ada" } }]);
        let (cursor, built) = apply(Resource::Star, "o/r", "", &stars, None, now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("2026-01-01T00:00:00Z", 0));
    }

    /// The age guard. A laptop opened on Monday must advance its cursor past the
    /// weekend WITHOUT dispatching it: skipping has to mean "acked, not
    /// delivered", because leaving the backlog unacked would re-evaluate the
    /// same page on every poll forever.
    #[test]
    fn stale_events_are_acked_but_never_dispatched() {
        // the parser, pinned against a hand-computed epoch — everything below
        // trusts it, and an off-by-an-hour here silently widens the window
        assert_eq!(parse_utc_ms("2026-07-18T12:34:56Z"), Some(1_784_378_096_000));
        assert_eq!(parse_utc_ms("2026-07-18T12:34:56.789Z"), Some(1_784_378_096_000));
        assert_eq!(parse_utc_ms("2026-07-18T12:34:56+02:00"), None, "not UTC");
        assert_eq!(parse_utc_ms("2026-07-18 12:34:56Z"), None);
        assert_eq!(parse_utc_ms("2026-13-18T12:34:56Z"), None);
        assert_eq!(parse_utc_ms(""), None);
        // fails open: an unreadable timestamp is never a reason to drop an event
        assert!(fresh("", now()));
        assert!(fresh("2026-07-18T12:20:57Z", now()), "one second inside the window");
        assert!(!fresh("2026-07-18T12:20:55Z", now()), "one second outside it");

        let issue = |ts: &str| json!([{ "number": 20, "user": {}, "created_at": ts }]);
        let (cursor, built) =
            apply(Resource::Issue, "o/r", "", &issue("2026-07-18T12:30:00Z"), Some("19"), now())
                .unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("20", 1), "a live issue must fire");
        let (cursor, built) =
            apply(Resource::Issue, "o/r", "", &issue("2026-07-17T09:00:00Z"), Some("19"), now())
                .unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("20", 0), "a stale issue must still be acked");

        // stars take the other path in `apply` — the cursor IS the timestamp
        let star = json!([{ "starred_at": "2026-07-17T09:00:00Z", "user": { "login": "grace" } }]);
        let (cursor, built) =
            apply(Resource::Star, "o/r", "", &star, Some("2026-07-16T00:00:00Z"), now()).unwrap();
        assert_eq!((cursor.as_str(), built.len()), ("2026-07-17T09:00:00Z", 0));

        // push has no timestamp until enrich_push supplies one, so its half of
        // the guard runs in poll_watch, on the Built
        let mut push = build_push("o/r", "main", "aaaaaaa", "bbbbbbb");
        assert!(fresh_built(&push, now()), "an unenrichable push must not be dropped");
        if let Some(slot) = push.fields.iter_mut().find(|(k, _)| k == "timestamp") {
            slot.1 = J::S("2026-07-17T09:00:00Z".into());
        }
        assert!(!fresh_built(&push, now()));
    }

    /// A cursor held only in memory re-baselines on every launch, which is the
    /// history-replay bug with extra steps.
    #[test]
    fn cursors_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("saturn-github-{}", uuid::Uuid::new_v4()));
        let path = dir.join("saturn.db");
        let key = "octocat/hello-world\ngithub-issue\n";
        {
            let store = Store::open(&path).unwrap();
            init(&store).unwrap();
            assert_eq!(load_cursor(&store, key), (None, None), "an unknown watch must baseline");
            save_cursor(&store, key, "17", "W/\"abc\"").unwrap();
            save_cursor(&store, key, "19", "W/\"def\"").unwrap();
        }
        {
            // a fresh process: same file, new connection, new Poller
            let store = Store::open(&path).unwrap();
            init(&store).unwrap();
            let (cursor, etag) = load_cursor(&store, key);
            assert_eq!(cursor.as_deref(), Some("19"));
            assert_eq!(etag.as_deref(), Some("W/\"def\""), "the ETag is what makes 304s free");
            // and the restart does not replay
            let feed = json!([{ "number": 19, "user": {} }]);
            let (_, built) = apply(Resource::Issue, "o/r", "", &feed, cursor.as_deref(), now()).unwrap();
            assert!(built.is_empty());
            // a blank ETag reads as absent, never as an `if-none-match: ""`
            save_cursor(&store, key, "19", "").unwrap();
            assert_eq!(load_cursor(&store, key).1, None);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Ported branch for branch from the TypeScript: each of these is a
    /// different recovery, and collapsing any two either hammers GitHub or gives
    /// up on something that would have fixed itself.
    #[test]
    fn the_error_taxonomy() {
        let now = 1_700_000_000_000i64;

        assert_eq!(classify(&res(200, &[], "[]"), now), Outcome::Ok);
        assert_eq!(classify(&res(304, &[], ""), now), Outcome::NotModified);
        // 401 is permanent — a bad PAT never fixes itself
        assert_eq!(classify(&res(401, &[], ""), now), Outcome::Dead);
        // 404/451 are NOT permanent: a renamed repo, or a token without access,
        // is fixable outside Saturn
        assert_eq!(classify(&res(404, &[], ""), now), Outcome::NotFound);
        assert_eq!(classify(&res(451, &[], ""), now), Outcome::NotFound);
        assert_eq!(classify(&res(500, &[], "boom"), now), Outcome::Backoff);
        assert_eq!(classify(&res(418, &[], ""), now), Outcome::Backoff);

        // primary rate limit: sleep to the reset (+2s), clamped into [60s, 1h]
        let reset = (now / 1_000) + 300;
        let limited = res(
            403,
            &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &reset.to_string())],
            "",
        );
        assert_eq!(classify(&limited, now), Outcome::RateLimited(Duration::from_millis(302_000)));
        // a reset already in the past still waits the floor, never zero
        let past = res(
            403,
            &[
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", &(now / 1_000 - 60).to_string()),
            ],
            "",
        );
        assert_eq!(classify(&past, now), Outcome::RateLimited(RATE_LIMIT_MIN_SLEEP));
        // an absurd reset is clamped to an hour rather than parking for a day
        let far = res(
            429,
            &[
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", &(now / 1_000 + 86_400).to_string()),
            ],
            "",
        );
        assert_eq!(classify(&far, now), Outcome::RateLimited(RATE_LIMIT_MAX_SLEEP));
        // Retry-After (secondary limit) wins over the reset headers
        let secondary = res(
            429,
            &[
                ("retry-after", "120"),
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", &reset.to_string()),
            ],
            "",
        );
        assert_eq!(classify(&secondary, now), Outcome::RateLimited(Duration::from_secs(120)));
        // a 403 with neither (permissions, or a headerless secondary limit)
        assert_eq!(classify(&res(403, &[], "forbidden"), now), Outcome::Backoff);
        assert_eq!(classify(&res(403, &[("x-ratelimit-remaining", "4999")], ""), now), Outcome::Backoff);
        // garbage headers must fall through, not become a sleep
        assert_eq!(classify(&res(403, &[("retry-after", "soon")], ""), now), Outcome::Backoff);

        // X-Poll-Interval is clamped both ways, and absence keeps the cadence
        let current = Duration::from_secs(POLL_S);
        assert_eq!(poll_interval(&res(200, &[], ""), current), current);
        assert_eq!(
            poll_interval(&res(200, &[("x-poll-interval", "1")], ""), current),
            Duration::from_secs(POLL_S),
        );
        assert_eq!(
            poll_interval(&res(200, &[("x-poll-interval", "120")], ""), current),
            Duration::from_secs(120),
        );
        assert_eq!(
            poll_interval(&res(200, &[("x-poll-interval", "99999")], ""), current),
            Duration::from_secs(MAX_POLL_S),
        );
        assert_eq!(poll_interval(&res(200, &[("x-poll-interval", "soon")], ""), current), current);

        // the last page of stargazers is the only place new stars appear
        let link = res(
            200,
            &[(
                "link",
                "<https://api.github.com/repositories/1/stargazers?per_page=100&page=2>; rel=\"next\", \
                 <https://api.github.com/repositories/1/stargazers?per_page=100&page=7>; rel=\"last\"",
            )],
            "[]",
        );
        assert_eq!(link_last_page(&link), Some(7));
        assert_eq!(link_last_page(&res(200, &[], "[]")), None, "one page is its own last page");
        // query-param order is GitHub's choice, not ours: a suffix search reads
        // `per_page=100` as the page number here and fetches an empty page 100,
        // so new stars would silently never be delivered
        let reordered = res(
            200,
            &[(
                "link",
                "<https://api.github.com/repositories/1/stargazers?page=7&per_page=100>; rel=\"last\"",
            )],
            "[]",
        );
        assert_eq!(link_last_page(&reordered), Some(7));
    }

    /// The backoff ladder and the 404 timer the taxonomy hands off to.
    #[test]
    fn backoff_doubles_to_a_ceiling_and_success_resets_it() {
        let mut poller = Poller::new();
        let key = "o/r\ngithub-issue\n";
        poller.backoff(key);
        assert_eq!(poller.state[key].backoff, Some(FIRST_BACKOFF * 2));
        poller.backoff(key);
        assert_eq!(poller.state[key].backoff, Some(FIRST_BACKOFF * 4));
        for _ in 0..10 {
            poller.backoff(key);
        }
        assert_eq!(poller.state[key].backoff, Some(MAX_BACKOFF), "the ladder must have a ceiling");
        assert!(poller.state[key].retry_at.is_some());

        poller.clear_backoff(key);
        assert_eq!(poller.state[key].backoff, None, "one success must reset the ladder");
        assert_eq!(poller.state[key].retry_at, None);

        // a 404 parks the watch for 15 minutes without touching the ladder
        poller.retry_in(key, NOT_FOUND_RETRY);
        assert!(poller.state[key].retry_at.unwrap() > Instant::now() + Duration::from_secs(890));
        assert_eq!(poller.state[key].backoff, None);
    }

    /// Fan-out: one fetch, N subscriptions, and the push branch filter — which
    /// may only ever narrow delivery.
    #[test]
    fn the_branch_filter_never_broadens_delivery() {
        let sub = |event: &str, branch: Option<&str>| EventSubscription {
            workflow_id: "w".into(),
            node_id: "n".into(),
            provider: "github".into(),
            event: event.into(),
            bot_token: String::new(),
            config: branch
                .map(|b| HashMap::from([("branch".to_string(), b.to_string())]))
                .unwrap_or_default(),
        };
        let push = build_push("o/r", "main", "aaaaaaa", "bbbbbbb");

        assert!(sub_wants_event(&sub("github-push", None), &push), "no filter takes every branch");
        assert!(sub_wants_event(&sub("github-push", Some("main")), &push));
        assert!(!sub_wants_event(&sub("github-push", Some("dev")), &push));
        assert!(!sub_wants_event(&sub("github-issue", None), &push), "wrong event");
        // a filter on a non-push event is not a filter — that config field only
        // exists on github-push
        let issue = build_issue("o/r", &json!({ "number": 1, "user": {} }));
        assert!(sub_wants_event(&sub("github-issue", Some("main")), &issue));
    }
}

