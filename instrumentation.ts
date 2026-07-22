// Next.js instrumentation hook — runs once per server start (never during
// `next build`; Next skips register() under NEXT_PHASE=phase-production-build,
// so the Pi's env-sourced build can't start loops). `next dev` DOES call this,
// hence the NODE_ENV gate: background work (scheduler + Discord Gateway +
// Telegram poller + sandbox reaper) starts in production servers (`next start`)
// or in dev when opted in via SATURN_DEV_BACKGROUND=1 (`npm run dev:full`) —
// only against a dev DB branch, never prod (bot-token single-consumer fights).
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    if (process.env.NODE_ENV !== "production" && process.env.SATURN_DEV_BACKGROUND !== "1") return;
    const { startBackground } = await import("./lib/background.server");
    startBackground();
}
