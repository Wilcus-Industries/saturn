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
