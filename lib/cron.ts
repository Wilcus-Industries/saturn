// human-readable summaries for the 4 cron shapes the visual builder emits;
// anything else is returned verbatim

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const pad2 = (n: number) => String(n).padStart(2, "0");

function ordinal(n: number): string {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    if (n % 10 === 1) return `${n}st`;
    if (n % 10 === 2) return `${n}nd`;
    if (n % 10 === 3) return `${n}rd`;
    return `${n}th`;
}

// plain non-negative integer within [min, max], else null (no ranges/steps/lists)
function num(field: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(field)) return null;
    const n = Number(field);
    return n >= min && n <= max ? n : null;
}

// "*/n" step (minute field only), n a plain integer in [2, 30], else null
function minuteStep(field: string): number | null {
    if (!field.startsWith("*/")) return null;
    return num(field.slice(2), 2, 30);
}

const FIELD_RANGES: [min: number, max: number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week
];

// accepts the grammar the visual builder can emit: exactly 5 fields, each
// "*" or a plain in-range integer (no ranges/steps/lists), plus "*/n" in the
// minute field only. Server actions validate with this — the create form is
// a public POST endpoint.
export function isValidCron(cron: string): boolean {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    return fields.every(
        (f, i) =>
            f === "*" ||
            num(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]) !== null ||
            (i === 0 && minuteStep(f) !== null),
    );
}

export function describeCron(cron: string): string {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return cron;
    const [mF, hF, domF, monF, dowF] = fields;
    if (monF !== "*") return cron;

    // * * * * *  /  */n * * * *  (the builder only steps minutes with all-star rest)
    if (hF === "*" && domF === "*" && dowF === "*") {
        if (mF === "*") return "every minute";
        const step = minuteStep(mF);
        if (step !== null) return `every ${step} minutes`;
    }

    const m = num(mF, 0, 59);
    if (m === null) return cron;

    // m * * * *
    if (hF === "*" && domF === "*" && dowF === "*") return `hourly at :${pad2(m)}`;

    const h = num(hF, 0, 23);
    if (h === null) return cron;
    const time = `${pad2(h)}:${pad2(m)}`;

    // m h * * *
    if (domF === "*" && dowF === "*") return `daily at ${time}`;

    // m h * * d
    if (domF === "*") {
        const d = num(dowF, 0, 6);
        return d === null ? cron : `${DAY_NAMES[d]} at ${time}`;
    }

    // m h D * *
    if (dowF === "*") {
        const dom = num(domF, 1, 31);
        return dom === null ? cron : `monthly on the ${ordinal(dom)} at ${time}`;
    }

    return cron;
}

// does the cron fire at this instant? Evaluated against UTC fields. Plain AND
// across all 5 fields — the standard dom/dow OR rule is deliberately skipped
// because the builder never restricts both. Invalid cron never matches.
export function cronMatches(cron: string, d: Date): boolean {
    if (!isValidCron(cron)) return false;
    const fields = cron.trim().split(/\s+/);
    const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
    return fields.every((f, i) => {
        if (f === "*") return true;
        const step = i === 0 ? minuteStep(f) : null;
        if (step !== null) return values[i] % step === 0;
        return Number(f) === values[i];
    });
}

// next UTC instant strictly after `from` at which the cron fires, or null when
// the cron is invalid or nothing matches inside a bounded 400-day scan. The scan
// is capped so a hand-authored dom+month combo that never comes around (only the
// MCP server can author such crons) can't loop forever; 400 days is > 1 year, so
// it spans a leap boundary and covers any dom+month pair that can ever fire.
// Builder-emitted crons never restrict month and always match within a day.
export function nextCronOccurrence(cron: string, from: Date): Date | null {
    if (!isValidCron(cron)) return null;
    const [, hF, domF, monF, dowF] = cron.trim().split(/\s+/);
    const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
    const end = start + 400 * 86_400_000;
    for (let t = start; t < end; ) {
        const d = new Date(t);
        // day prefilter: a literal date field that can't match today skips
        // straight to the next UTC midnight instead of crawling by minute
        if (
            (num(domF, 1, 31) !== null && Number(domF) !== d.getUTCDate()) ||
            (num(monF, 1, 12) !== null && Number(monF) !== d.getUTCMonth() + 1) ||
            (num(dowF, 0, 6) !== null && Number(dowF) !== d.getUTCDay())
        ) {
            t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
            continue;
        }
        // hour prefilter: a literal hour that isn't now skips to the next hour
        if (num(hF, 0, 23) !== null && Number(hF) !== d.getUTCHours()) {
            t += (60 - d.getUTCMinutes()) * 60_000;
            continue;
        }
        if (cronMatches(cron, d)) return d;
        t += 60_000;
    }
    return null;
}

// shortest gap (minutes) between two firings, for tier-floor checks
export function cronMinIntervalMinutes(cron: string): number {
    const [mF, hF, domF, , dowF] = cron.trim().split(/\s+/);
    if (mF === "*") return 1;
    const step = minuteStep(mF);
    if (step !== null) return step;
    if (hF === "*") return 60; // hourly
    if (domF === "*" && dowF === "*") return 1440; // daily
    return 10080; // weekly or sparser
}
