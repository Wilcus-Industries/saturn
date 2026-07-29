//! The shell tool: a model-written command run under a macOS seatbelt profile.
//!
//! The command text is untrusted — a model wrote it, often from text a web page
//! or an MCP server handed it — so nothing here tries to *read* the command.
//! Parsing a shell line to decide whether it is safe is a losing game
//! (`$(...)`, `eval`, a base64 pipe, a script the command downloads), so the
//! boundary is the kernel's, not a parser's: `sandbox-exec` applies the policy
//! to every process in the tree regardless of what the line expands to. The
//! command is always an argv element handed to `/bin/sh -c`, never interpolated
//! into the profile.
//!
//! Seatbelt matches **resolved** paths, which is why every path in the profile
//! is `canonicalize`d first. `$TMPDIR` on macOS is a symlink chain into
//! `/private/var/folders/...`; a rule written against the `/var/...` spelling
//! silently matches nothing, and a silently-empty rule is a policy that looks
//! right in review and is not there at runtime.
//!
//! The read/write split is only about **writes**. Reads stay broad in both
//! modes because a shell is unusable otherwise — it needs `/usr`, `/bin`, the
//! dyld cache, every library it loads. "read" therefore means *nothing outside
//! the process temp dir is writable*; "read+write" adds exactly the cwd tree.
//! The credential directories are denied for *reading* in both modes: this tool
//! has the network, so `~/.ssh` plus a `curl` is the whole exfiltration path,
//! and that guard has nothing to do with the write grant.
//!
//! The cwd is the chat session's working directory: where the command starts
//! and the only durable thing it can write. It is user-chosen (a folder picker,
//! defaulting to `$HOME`), so it is validated (absolute, creatable) and escaped
//! before it reaches the profile's quoted string literal — a path carrying a `"`
//! would otherwise close the literal and rewrite the policy.
//!
//! Because the default cwd is `$HOME` itself, the credential denies are emitted
//! **after** the cwd carve-out. Seatbelt is last-match-wins, so a deny written
//! before an enclosing allow is an absent rule: with the old ordering a
//! read+write grant on `~` made `~/.ssh` writable.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A sandboxed command gets a clean environment; this is the whole `PATH`.
/// Homebrew's two prefixes are in it because that is where a user's `rg`, `jq`
/// or `gh` actually lives on a Mac.
const PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";
/// Wall-clock ceiling for one command.
const DEADLINE: Duration = Duration::from_secs(60);
/// Bytes kept per stream while the command runs. Well above the render cap so
/// truncation is decided once, at the end, but bounded so `yes` cannot grow the
/// process without limit.
const MAX_CAPTURE: usize = 400_000;
/// Chars of rendered result handed back. Mirrors `MAX_TOOL_RESULT` in
/// `saturn.rs` (20_000) — deliberately duplicated rather than imported, so this
/// module stays independent of the chat loop; keep the two in step.
const MAX_OUTPUT: usize = 20_000;
/// Directories denied for *reading* in both modes, relative to `$HOME`.
///
/// `Library/Keychains` is the load-bearing one and is NOT redundant with the
/// write deny — do not delete it. The login keychain is a *file*, and the
/// `security` CLI reads it directly: without this rule
/// `security find-generic-password -s com.wilcus.saturn` enumerates Saturn's
/// own items from inside the sandbox; with it the call fails to find them. That
/// is Saturn's central secrets invariant (CLAUDE.md, "Secrets — write-only,
/// everywhere": the OpenRouter key, MCP auth tokens and secret variable values
/// are Keychain items and no read path returns one) held up by a file-read
/// deny. The other four are the same shape for the credentials Saturn does not
/// own but the user's shell can reach.
const SECRET_DIRS: [&str; 5] = [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains"];

/// `$HOME`, resolved. Everything else in the profile hangs off it.
fn home() -> Result<PathBuf, String> {
    let raw = std::env::var("HOME").unwrap_or_default();
    if raw.is_empty() {
        return Err("HOME is not set, so the sandbox has no home directory to protect".into());
    }
    std::fs::canonicalize(&raw).map_err(|e| format!("cannot resolve home directory {raw}: {e}"))
}

/// Is this a shape `cwd_dir` will accept? The command that stores a session's
/// directory validates with this instead of keeping its own copy of the rule: a
/// path the picker takes and `run` later refuses is a setting the user cannot
/// fix from the UI.
///
/// Shape only. Whether the directory can actually be created is `cwd_dir`'s
/// answer, at the moment it matters.
pub fn valid_cwd(configured: &str) -> bool {
    let configured = configured.trim();
    configured.is_empty() || configured.starts_with("~/") || Path::new(configured).is_absolute()
}

/// Resolve a session's stored directory to a real, existing, canonical path.
/// `configured` is what the session row holds; empty means `$HOME`.
pub fn cwd_dir(configured: &str) -> Result<PathBuf, String> {
    let configured = configured.trim();
    let dir = if configured.is_empty() {
        home()?
    } else if let Some(rest) = configured.strip_prefix("~/") {
        // the UI renders stored paths tilde-abbreviated, so the abbreviated
        // spelling has to round-trip. `~` is shell syntax, not path syntax —
        // nothing below this expands it
        home()?.join(rest)
    } else {
        let dir = PathBuf::from(configured);
        if !dir.is_absolute() {
            return Err(format!("directory must be an absolute path, got \"{configured}\""));
        }
        dir
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create directory {}: {e}", dir.display()))?;
    // canonicalize AFTER create_dir_all: it fails on a path that does not exist,
    // and its output is what the seatbelt profile must carry (see the header).
    std::fs::canonicalize(&dir)
        .map_err(|e| format!("cannot resolve directory {}: {e}", dir.display()))
}

/// `$HOME` written back as `~` — how a path is shown in the composer, and the
/// spelling `cwd_dir` reads back. Kept here beside `cwd_dir` so the two halves
/// of the round trip cannot drift.
pub fn abbreviate(dir: &Path) -> String {
    let raw = dir.to_string_lossy().into_owned();
    let Ok(home) = home() else { return raw };
    match dir.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => raw,
    }
}

/// A path as a seatbelt string literal. Backslash first, then the quote —
/// escaping the quote first would leave the backslash it introduced to be
/// escaped again, doubling it. This is the one place user config becomes policy
/// syntax; a path that broke out of the literal would rewrite the whole profile.
fn quoted(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for c in raw.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// The profile, built per call. Seatbelt is last-match-wins: the blanket
/// write-deny lands first, then the carve-outs, then the credential denies —
/// which must come **last**, because the cwd can enclose them. All three paths
/// arrive already canonicalized.
fn profile(home: &Path, tmp: &Path, cwd: &Path, write: bool) -> String {
    let denied: Vec<String> =
        SECRET_DIRS.iter().map(|d| format!("(subpath {})", quoted(&home.join(d)))).collect();
    let denied = denied.join(" ");
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str("(allow default)\n");
    out.push_str("(deny file-write* (subpath \"/\"))\n");
    out.push_str(&format!("(allow file-write* (subpath {}))\n", quoted(tmp)));
    // Also load-bearing, not politeness: `(deny file-write* (subpath "/"))`
    // covers /dev, so without this `curl -o /dev/null` dies with "Failure
    // writing output to destination" while TLS itself works fine, and every
    // `2>/dev/null` in a one-liner breaks. To the model that reads as a broken
    // tool, not as a policy.
    out.push_str("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/tty\"))\n");
    if write {
        out.push_str(&format!("(allow file-write* (subpath {}))\n", quoted(cwd)));
    }
    // AFTER the cwd allow, both of them. The default cwd is `$HOME`, which
    // encloses every one of these, so a deny emitted first would be overridden
    // by the allow above and `~/.ssh` would be writable — and readable — from a
    // read+write grant. `sandbox_denies_credentials_even_when_the_cwd_is_home`
    // is what fails if these two lines drift back up.
    out.push_str(&format!("(deny file-read* {denied})\n"));
    out.push_str(&format!("(deny file-write* {denied})\n"));
    out
}

/// Reads a child pipe to EOF on its own thread into a shared buffer.
///
/// Both pipes must be drained concurrently with the wait: a command that fills
/// the 64KB pipe buffer blocks on `write` forever while the parent sits in a
/// `try_wait` poll loop that will never see it exit. The buffer is shared
/// rather than returned by `join` so the parent never has to *wait* on these
/// threads either — a grandchild holding the write end keeps the pipe open long
/// after the leader is dead, and joining on that is the same deadlock moved one
/// process along.
fn drain<R: Read + Send + 'static>(mut pipe: R) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&buf);
    let handle = std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let mut held = sink.lock().unwrap_or_else(|e| e.into_inner());
                    if held.len() < MAX_CAPTURE {
                        held.extend_from_slice(&chunk[..n]);
                    }
                    // keep reading past the cap and discard: stopping here would
                    // block the child on a full pipe instead of letting it finish
                }
            }
        }
    });
    (buf, handle)
}

/// Give a drain thread a moment to deliver the final chunk once the child is
/// gone. Bounded on purpose — see `drain`.
fn settle(handle: &std::thread::JoinHandle<()>) {
    let until = Instant::now() + Duration::from_millis(250);
    while !handle.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn taken(buf: &Arc<Mutex<Vec<u8>>>) -> String {
    let held = buf.lock().unwrap_or_else(|e| e.into_inner());
    String::from_utf8_lossy(&held).into_owned()
}

/// Cut the middle, not the tail: the head says what the command did and the
/// tail carries the error it died on. Losing either loses the answer.
fn cap(text: &str) -> String {
    let total = text.chars().count();
    if total <= MAX_OUTPUT {
        return text.to_string();
    }
    let budget = MAX_OUTPUT - 80; // leaves room for the marker line
    let head = budget * 2 / 3;
    let tail = budget - head;
    let at = |n: usize| text.char_indices().nth(n).map(|(i, _)| i).unwrap_or(text.len());
    let cut = total - head - tail;
    format!("{}\n... [{cut} characters cut from the middle] ...\n{}", &text[..at(head)], &text[at(total - tail)..])
}

fn render(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let code = match code {
        Some(c) => c.to_string(),
        None => "killed by a signal".to_string(),
    };
    let body = |s: &str| if s.trim().is_empty() { "(empty)".to_string() } else { s.trim_end().to_string() };
    cap(&format!("exit code: {code}\nstdout:\n{}\nstderr:\n{}", body(stdout), body(stderr)))
}

/// Run `command` under a macOS seatbelt sandbox. `write` is the user's grant:
/// false = "read" (nothing outside the process temp dir is writable),
/// true = "read+write" (the cwd tree is additionally writable).
///
/// `configured_cwd` is the chat session's stored directory; empty means `$HOME`.
///
/// A non-zero exit is a normal `Ok` — the model reads the code and the stderr
/// and decides what to do. `Err` is a harness failure: no directory, no
/// sandbox, or the deadline.
pub fn run(command: &str, write: bool, configured_cwd: &str) -> Result<String, String> {
    let cwd = cwd_dir(configured_cwd)?;
    let home = home()?;
    let tmp = std::env::temp_dir();
    let tmp = std::fs::canonicalize(&tmp)
        .map_err(|e| format!("cannot resolve temp directory {}: {e}", tmp.display()))?;
    let profile = profile(&home, &tmp, &cwd, write);

    let mut child = Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(&profile)
        // the command is an argv element, never part of the profile
        .arg("/bin/sh")
        .arg("-c")
        .arg(command)
        .current_dir(&cwd)
        // an interactive command must read EOF, not block on a tty that is the
        // app's own terminal
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", PATH)
        .env("HOME", &home)
        .env("TMPDIR", &tmp)
        .env("LANG", "en_US.UTF-8")
        .spawn()
        .map_err(|e| format!("could not start the sandbox: {e}"))?;

    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);

    let deadline = Instant::now() + DEADLINE;
    let mut status = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(done)) => {
                status = Some(done);
                break;
            }
            Ok(None) => {}
            Err(e) => return Err(format!("could not wait for the sandbox: {e}")),
        }
        if Instant::now() >= deadline {
            // ponytail: kill() reaps the leader only — a backgrounded grandchild
            // (`sh -c "sleep 999 &"`) survives, still sandboxed but running.
            // Upgrade path: process_group(0) on the child plus kill(-pgid),
            // which needs libc. Not worth a dependency until one leaks.
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some((buf, handle)) = &out {
        settle(handle);
        stdout = taken(buf);
    }
    if let Some((buf, handle)) = &err {
        settle(handle);
        stderr = taken(buf);
    }

    if timed_out {
        return Err(cap(&format!(
            "the command was killed: it was still running after {}s.\nstdout so far:\n{stdout}\nstderr so far:\n{stderr}",
            DEADLINE.as_secs()
        )));
    }
    Ok(render(status.and_then(|s| s.code()), &stdout, &stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cwd the sandbox rules must actually reach: under `$HOME`, and
    /// deliberately NOT under `$TMPDIR`, where the temp carve-out would let
    /// every write through and the test would pass without the cwd rule.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            home().unwrap().join("Saturn").join(format!(".bash-test-{}-{tag}", std::process::id()));
        cwd_dir(dir.to_str().unwrap()).unwrap()
    }

    #[test]
    fn cwd_must_be_absolute_but_a_leading_tilde_expands() {
        assert!(cwd_dir("relative/dir").unwrap_err().contains("absolute"));
        assert!(cwd_dir("~sneaky/dir").unwrap_err().contains("absolute"));
        // the abbreviated spelling the composer stores has to round-trip
        assert_eq!(cwd_dir("~/Saturn").unwrap(), home().unwrap().join("Saturn"));
        // nothing configured is the home directory itself
        assert_eq!(cwd_dir("").unwrap(), home().unwrap());
        assert_eq!(abbreviate(&home().unwrap()), "~");
        assert_eq!(abbreviate(&home().unwrap().join("Saturn")), "~/Saturn");
    }

    /// The default cwd is `$HOME`, which encloses every credential directory.
    /// The denies therefore have to be emitted after the cwd carve-out, or
    /// read+write on `~` hands the model `~/.ssh` — the exfiltration path the
    /// header calls out. Ordering only; the runtime half is the test below.
    #[test]
    fn sandbox_denies_credentials_even_when_the_cwd_is_home() {
        let home = Path::new("/Users/x");
        let text = profile(home, Path::new("/private/tmp"), home, true);
        let allow = text.find("(allow file-write* (subpath \"/Users/x\"))").expect("cwd allow");
        let read = text.find("(deny file-read* ").expect("credential read deny");
        let write = text.find("(deny file-write* (subpath \"/Users/x/.ssh\")").expect("write deny");
        assert!(read > allow, "the credential read deny must land after the cwd allow:\n{text}");
        assert!(write > allow, "the credential write deny must land after the cwd allow:\n{text}");
        assert!(text.contains("Library/Keychains"), "{text}");
    }

    /// The load-bearing test: the write grant is the sandbox, not a flag we
    /// carry around. Home stays unwritable at both settings.
    #[test]
    fn sandbox_confines_writes_to_the_cwd() {
        let ws = scratch("writes");
        let ws_arg = ws.to_str().unwrap();
        let escape = home().unwrap().join(format!(".saturn-bash-escape-{}", std::process::id()));

        // read+write: the workspace tree is writable, home still is not
        let granted = run("echo hi > inside.txt && cat inside.txt", true, ws_arg).unwrap();
        assert!(granted.contains("exit code: 0"), "{granted}");
        assert!(granted.contains("hi"), "{granted}");
        assert!(ws.join("inside.txt").exists(), "the granted write did not land");

        let out = run(&format!("echo x > {}", escape.display()), true, ws_arg).unwrap();
        assert!(!out.contains("exit code: 0"), "home write must fail at write=true: {out}");
        assert!(!escape.exists(), "home is writable at write=true");

        // read: the same workspace write is now denied
        let denied = run("echo hi > refused.txt", false, ws_arg).unwrap();
        assert!(!denied.contains("exit code: 0"), "workspace write must fail at write=false: {denied}");
        assert!(!ws.join("refused.txt").exists(), "the workspace is writable at write=false");

        let out = run(&format!("echo x > {}", escape.display()), false, ws_arg).unwrap();
        assert!(!out.contains("exit code: 0"), "home write must fail at write=false: {out}");
        assert!(!escape.exists(), "home is writable at write=false");

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_file(&escape);
    }

    /// A cwd path is user input interpolated into a quoted scheme literal. If it
    /// can carry an unescaped `"` it can append its own rules.
    #[test]
    fn a_quote_in_the_cwd_path_cannot_break_out_of_the_literal() {
        let hostile = PathBuf::from("/tmp/we\"ird\\path\") (allow file-write* (subpath \"/");
        let text = profile(Path::new("/Users/x"), Path::new("/private/tmp"), &hostile, true);
        // the cwd allow is no longer the last line — the credential denies are
        let line = text.lines().find(|l| l.contains("we")).unwrap();
        assert_eq!(
            line,
            r#"(allow file-write* (subpath "/tmp/we\"ird\\path\") (allow file-write* (subpath \"/"))"#
        );
        // exactly two unescaped quotes on that line: the ones we opened and closed
        let bare = line.as_bytes().iter().enumerate().filter(|(i, b)| {
            **b == b'"' && (*i == 0 || line.as_bytes()[i - 1] != b'\\')
        });
        assert_eq!(bare.count(), 2, "{line}");
    }

    /// The runtime half of the ordering test: the real kernel, the real default
    /// cwd, the full read+write grant — and `~/.ssh` still refuses both.
    #[test]
    fn a_read_write_grant_on_the_home_cwd_still_cannot_touch_credentials() {
        let probe = home().unwrap().join(".ssh/.saturn-probe");
        // a leftover from an earlier failing run would make this pass on stale
        // state — and a run that *does* escape the sandbox is exactly when one
        // gets left behind
        std::fs::remove_file(&probe).ok();
        let out = run(&format!("cat ~/.ssh/* ; echo x > {}", probe.display()), true, "").unwrap();
        assert!(!out.contains("exit code: 0"), "~/.ssh is reachable from the home cwd: {out}");
        assert!(!probe.exists(), "~/.ssh is writable from the home cwd");
    }

    #[test]
    fn a_failing_command_is_ok_and_carries_its_code_and_stderr() {
        let ws = scratch("exit");
        let out = run("echo boom >&2; exit 7", false, ws.to_str().unwrap()).unwrap();
        assert!(out.contains("exit code: 7"), "{out}");
        assert!(out.contains("boom"), "{out}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn output_is_capped_with_a_visible_marker() {
        let long = "x".repeat(MAX_OUTPUT * 2);
        let cut = cap(&long);
        assert!(cut.chars().count() <= MAX_OUTPUT, "{}", cut.chars().count());
        assert!(cut.contains("cut from the middle"));
    }
}
