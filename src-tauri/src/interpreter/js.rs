//! The JavaScript value semantics `lib/interpreter.ts` runs on, ported exactly.
//! Rust agrees with none of it by default:
//!
//! - `String(n)` is not `f64: Display`. JS prints `1e+21`, `1e-7`, `Infinity`,
//!   and `0` for `-0`; Rust prints the digits out in full, `inf`, and `-0`.
//! - `Number(s)` accepts `0x10` / `+5` / `Infinity` and rejects `inf`, `nan`
//!   and `1_000`, all of which `f64::from_str` gets backwards.
//! - `<` on strings orders UTF-16 code units, not UTF-8 bytes.
//! - `JSON.stringify` keeps an object's key order and writes whole floats
//!   without a `.0`. `serde_json::Value` sorts keys (BTreeMap) and ryu writes
//!   `1000.0` — both are visible in `fixtures/expected/extract.json`, so this
//!   file carries its own JSON tree rather than fighting serde_json's.

use std::cmp::Ordering;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// `RunValue` — `string | number | boolean`. The variant is load-bearing, not
/// decoration: `asNumber(true)` is `1` while `asNumber("true")` is `NaN`, so an
/// `if` comparing a boolean against `1` answers differently for each.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    S(String),
    N(f64),
    B(bool),
}

impl Value {
    pub fn str(v: impl Into<String>) -> Value {
        Value::S(v.into())
    }

    /// `String(v)`
    pub fn text(&self) -> String {
        match self {
            Value::S(s) => s.clone(),
            Value::N(n) => num_to_string(*n),
            Value::B(b) => b.to_string(),
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Value::B(b) => *b,
            Value::N(n) => *n != 0.0 && !n.is_nan(),
            Value::S(s) => !s.is_empty() && s != "false" && s != "0",
        }
    }

    /// `asNumber`: a blank string is not numeric — `Number("")` is 0, which
    /// would make `"" == 0` true.
    fn as_number(&self) -> f64 {
        match self {
            Value::S(s) if trim(s).is_empty() => f64::NAN,
            Value::S(s) => to_number(s),
            Value::N(n) => *n,
            Value::B(b) => f64::from(u8::from(*b)),
        }
    }
}

/// The `if` node's comparison: numeric when *both* sides coerce cleanly, string
/// otherwise. `IF_OPERATORS` is the whole set; anything else is false.
pub fn compare(a: &Value, b: &Value, op: &str) -> bool {
    if op == "contains" {
        return a.text().contains(&b.text());
    }
    let (na, nb) = (a.as_number(), b.as_number());
    if !na.is_nan() && !nb.is_nan() {
        return match op {
            "==" => na == nb,
            "!=" => na != nb,
            "<" => na < nb,
            ">" => na > nb,
            "<=" => na <= nb,
            ">=" => na >= nb,
            _ => false,
        };
    }
    let (sa, sb) = (a.text(), b.text());
    // JS orders strings by UTF-16 code unit; Rust's Ord walks UTF-8 bytes, which
    // disagrees for astral chars against U+E000..U+FFFF
    let ord = sa.encode_utf16().cmp(sb.encode_utf16());
    match op {
        "==" => ord == Ordering::Equal,
        "!=" => ord != Ordering::Equal,
        "<" => ord == Ordering::Less,
        ">" => ord == Ordering::Greater,
        "<=" => ord != Ordering::Greater,
        ">=" => ord != Ordering::Less,
        _ => false,
    }
}

/// `String(n)` — ECMA-262 Number::toString, radix 10.
pub fn num_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into(); // -0 included
    }
    if n < 0.0 {
        return format!("-{}", num_to_string(-n));
    }
    if n.is_infinite() {
        return "Infinity".into();
    }
    // Rust's LowerExp is the shortest round-tripping decimal, which is exactly
    // the digit string ECMA specifies; only the layout around it differs.
    let e = format!("{n:e}");
    let (mantissa, exp) = e.split_once('e').expect("LowerExp always emits e");
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    // ECMA-262 picks, among equally short round-tripping digit strings, the one
    // closest to the value — and on an exact tie "the one that is even". Rust's
    // shortest formatter rounds half away from zero, so a tie comes back as the
    // odd upper neighbour (1420396063617288.3 where JS says …8.2). The tie is
    // visible in the exact expansion: exactly one more digit, a 5, then zeros.
    if digits.as_bytes()[digits.len() - 1] % 2 == 1 {
        let k = digits.len();
        let wide = format!("{:.*e}", k + 20, n);
        let wide: Vec<u8> = wide
            .split_once('e')
            .expect("LowerExp always emits e")
            .0
            .bytes()
            .filter(|b| *b != b'.')
            .collect();
        if wide[k] == b'5' && wide[k + 1..].iter().all(|b| *b == b'0') {
            digits = String::from_utf8(wide[..k].to_vec()).expect("ascii digits");
        }
    }
    let k = digits.len() as i32;
    // `n` in the spec: the decimal point sits after this many digits
    let point = exp.parse::<i32>().expect("LowerExp exponent") + 1;
    if k <= point && point <= 21 {
        return format!("{digits}{}", "0".repeat((point - k) as usize));
    }
    if 0 < point && point <= 21 {
        return format!("{}.{}", &digits[..point as usize], &digits[point as usize..]);
    }
    if -6 < point && point <= 0 {
        return format!("0.{}{digits}", "0".repeat(-point as usize));
    }
    let sign = if point - 1 >= 0 { '+' } else { '-' };
    let mag = (point - 1).abs();
    if k == 1 {
        format!("{digits}e{sign}{mag}")
    } else {
        format!("{}.{}e{sign}{mag}", &digits[..1], &digits[1..])
    }
}

/// `String.prototype.trim`. JS trims StrWhiteSpace, which is Rust's `White_Space`
/// property minus U+0085 (NEL — Rust trims it, JS does not) plus U+FEFF (the BOM
/// — JS trims it, Rust does not). Both show up for real: a BOM survives a
/// copy-paste out of a file, and either one flips `Number(s)` between a value
/// and NaN, which decides an `if`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `Number(s)`. NaN for anything JS rejects — notably `inf`, `nan` and `1_000`,
/// which `f64::from_str` would happily take.
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let mut acc = 0.0;
        let mut any = false;
        for c in t[2..].chars() {
            let Some(d) = c.to_digit(radix) else {
                return f64::NAN;
            };
            acc = acc * f64::from(radix) + f64::from(d);
            any = true;
        }
        return if any { acc } else { f64::NAN };
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // reject every literal form Rust accepts and JS does not before parsing
    if t.bytes()
        .any(|b| !matches!(b, b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

// --- JSON ------------------------------------------------------------------

/// A JSON tree that keeps object key order (`JSON.parse` + `JSON.stringify`
/// round-trip `{"b":1,"a":2}` unchanged) and holds every number as the f64
/// `JSON.parse` would produce.
pub enum J {
    Null,
    B(bool),
    N(f64),
    S(String),
    A(Vec<J>),
    // ponytail: duplicate keys are kept, not merged — JS keeps the last value at
    // the first position. Reachable only from hand-written duplicate-key JSON.
    O(Vec<(String, J)>),
}

impl J {
    /// The scalar cases `extract` and `loop` hand back with their type intact;
    /// everything else is stringified by the caller.
    pub fn scalar(&self) -> Option<Value> {
        match self {
            J::B(b) => Some(Value::B(*b)),
            J::N(n) => Some(Value::N(*n)),
            J::S(s) => Some(Value::S(s.clone())),
            _ => None,
        }
    }
}

pub fn parse(s: &str) -> Result<J, serde_json::Error> {
    serde_json::from_str(s)
}

/// `JSON.stringify(v)` for a value that came out of `JSON.parse` (no undefined,
/// no cycles, no toJSON).
pub fn stringify(j: &J) -> String {
    let mut out = String::new();
    write(j, &mut out);
    out
}

pub fn stringify_values(values: &[Value]) -> String {
    let items: Vec<J> = values
        .iter()
        .map(|v| match v {
            Value::S(s) => J::S(s.clone()),
            Value::N(n) => J::N(*n),
            Value::B(b) => J::B(*b),
        })
        .collect();
    stringify(&J::A(items))
}

/// `loop` items: a JSON array if it parses as one, else comma-separated.
pub fn to_list(items: &Value) -> Vec<Value> {
    let Value::S(s) = items else {
        return vec![items.clone()];
    };
    let trimmed = trim(s);
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') {
        if let Ok(J::A(parsed)) = parse(trimmed) {
            return parsed
                .iter()
                .map(|x| x.scalar().unwrap_or_else(|| Value::S(stringify(x))))
                .collect();
        }
        // malformed, or not an array after all — fall through to comma-split
    }
    trimmed
        .split(',')
        .map(|part| Value::S(trim(part).to_string()))
        .collect()
}

fn write(j: &J, out: &mut String) {
    match j {
        J::Null => out.push_str("null"),
        J::B(b) => out.push_str(if *b { "true" } else { "false" }),
        // JSON.stringify writes a non-finite number as null
        J::N(n) if !n.is_finite() => out.push_str("null"),
        J::N(n) => out.push_str(&num_to_string(*n)),
        // serde_json escapes exactly what JSON.stringify escapes
        J::S(s) => out.push_str(&serde_json::to_string(s).expect("string")),
        J::A(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        J::O(fields) => {
            out.push('{');
            for (i, (k, v)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("key"));
                out.push(':');
                write(v, out);
            }
            out.push('}');
        }
    }
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<J, E> {
                Ok(J::B(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<J, E> {
                Ok(J::N(v as f64))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<J, E> {
                Ok(J::N(v as f64))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<J, E> {
                Ok(J::N(v))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<J, E> {
                Ok(J::S(v.to_string()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<J, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = a.next_element()? {
                    items.push(item);
                }
                Ok(J::A(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<J, A::Error> {
                let mut fields = Vec::new();
                while let Some(entry) = m.next_entry::<String, J>()? {
                    fields.push(entry);
                }
                Ok(J::O(fields))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every one of these is a value Rust's own formatter renders differently.
    #[test]
    fn number_to_string_matches_js() {
        for (n, want) in [
            (1.0, "1"),
            (-0.0, "0"),
            (2.5, "2.5"),
            (-2.5, "-2.5"),
            (1000.0, "1000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (0.5, "0.5"),
            (1.5e-7, "1.5e-7"),
            (9007199254740992.0, "9007199254740992"),
            (1e300, "1e+300"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
            // shortest-digits ties: ECMA breaks toward the EVEN candidate while
            // Rust's own shortest formatter rounds half away from zero. Both
            // directions, so a blanket "always round down" would be wrong too.
            (-1420608204620385.2, "-1420608204620385.2"), // spec takes the lower
            (-105168144873702.38, "-105168144873702.38"), // spec keeps the upper
        ] {
            assert_eq!(num_to_string(n), want, "{n:?}");
        }
    }

    #[test]
    fn to_number_matches_js() {
        for (s, want) in [
            (" 7 ", Some(7.0)),
            ("1e3", Some(1000.0)),
            ("0x1f", Some(31.0)),
            ("0b101", Some(5.0)),
            ("+5", Some(5.0)),
            ("01", Some(1.0)),
            ("5.0", Some(5.0)),
            ("", Some(0.0)),
            ("Infinity", Some(f64::INFINITY)),
            ("1_000", None),
            ("inf", None),
            ("nan", None),
            ("NaN", None),
            ("true", None),
            ("0x", None),
            ("abc", None),
            // StrWhiteSpace is not Rust's White_Space: JS trims the BOM and does
            // not trim NEL, and either one flips a number into NaN
            ("\u{feff}5", Some(5.0)),
            ("\u{feff}", Some(0.0)),
            ("\u{85}5", None),
        ] {
            let got = to_number(s);
            match want {
                Some(w) => assert_eq!(got, w, "{s:?}"),
                None => assert!(got.is_nan(), "{s:?} -> {got}"),
            }
        }
    }

    #[test]
    fn json_keeps_key_order_and_js_numbers() {
        let j = parse(r#"{"b":1e3,"a":[2,true,null,"q\"q"]}"#).unwrap();
        assert_eq!(stringify(&j), r#"{"b":1000,"a":[2,true,null,"q\"q"]}"#);
        assert!(parse("not json").is_err());
    }

    /// The boolean/number/string split the `if` fixtures exist for.
    #[test]
    fn compare_coerces_like_js() {
        let t = || Value::B(true);
        assert!(compare(&t(), &Value::N(1.0), "=="));
        assert!(compare(&t(), &Value::str("true"), "=="));
        assert!(!compare(&Value::str("true"), &Value::N(1.0), "=="));
        assert!(compare(&Value::str("true"), &Value::N(1.0), ">")); // string branch
        assert!(compare(&Value::str(" 5 "), &Value::N(5.0), "=="));
        assert!(!compare(&Value::str(""), &Value::N(0.0), "==")); // blank is not numeric
        assert!(compare(&Value::str("10"), &Value::str("9"), ">")); // both numeric
        assert!(compare(&Value::str("abc"), &Value::str("abd"), "<"));
        assert!(!compare(&Value::str("a"), &Value::str("b"), "nonsense"));
    }
}
