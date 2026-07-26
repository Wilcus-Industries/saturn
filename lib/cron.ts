// human-readable summaries for the 4 cron shapes the visual builder emits;
// anything else is returned verbatim

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export const pad2 = (n: number) => String(n).padStart(2, "0");

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
