// Next.js instrumentation hook — runs once per server start (never during
// `next build`; Next skips register() under NEXT_PHASE=phase-production-build,
// so the Pi's env-sourced build can't start loops). `next dev` DOES call this,
// hence the NODE_ENV gate: background work (cron scheduler + Discord Gateway)
// starts only in production servers (`next start`), never in dev.
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    if (process.env.NODE_ENV !== "production") return;
    const { startBackground } = await import("./lib/background.server");
    startBackground();
}
