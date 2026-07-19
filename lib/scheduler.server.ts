// In-process cron scheduler — replaces the Pi's per-minute systemd timer.
// A self-arming timeout fires just past each :00; the next arm happens only
// after the current tick finishes, so ticks never overlap in-process. The
// runner's claim UPDATE stays the cross-process idempotency backstop (manual
// /api/cron curls, a transitional systemd timer, a stray second process).
//
// Catch-up: a long tick or event-loop stall skips minutes; we track the last
// processed UTC minute and run each missed one (capped) so sparse crons
// (e.g. "0 9 * * *") recover. Tight crons collapse: the claim guard turns the
// burst of retro ticks into a single run.
import { runDueWorkflows } from "@/lib/runner.server";

const MINUTE = 60_000;
const MAX_CATCHUP_MINUTES = 5; // a long sleep must not burst-fire history

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startScheduler() {
    stopped = false;
    // the boot minute counts as handled — whatever ran before this process
    // (systemd timer, previous process) owned everything up to now
    let lastMinute = Date.now() - (Date.now() % MINUTE);

    const arm = () => {
        if (stopped) return;
        // +250ms past :00 absorbs timer drift either side of the boundary
        timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE) + 250);
        timer.unref();
    };

    const tick = async () => {
        const nowMinute = Date.now() - (Date.now() % MINUTE);
        const from = Math.max(lastMinute + MINUTE, nowMinute - MAX_CATCHUP_MINUTES * MINUTE);
        for (let m = from; m <= nowMinute && !stopped; m += MINUTE) {
            try {
                const { due, ran } = await runDueWorkflows(new Date(m));
                if (due > 0)
                    console.log(
                        `[scheduler] ${new Date(m).toISOString()} due=${due} ran=${ran}`,
                    );
            } catch (err) {
                console.error("[scheduler] tick failed", err);
            }
            lastMinute = m;
        }
        arm();
    };

    console.log(`[scheduler] started (catch-up <= ${MAX_CATCHUP_MINUTES} min)`);
    arm();
}

export function stopScheduler() {
    stopped = true;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
