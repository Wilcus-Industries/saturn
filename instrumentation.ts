// Next.js instrumentation hook — runs once per server start (never during
// `next build`; Next skips register() under NEXT_PHASE=phase-production-build,
// so the Pi's env-sourced build can't start loops). `next dev` DOES call this,
// hence the env gate: background work runs only where SATURN_BACKGROUND=1
// (set in /etc/saturn/saturn.env in prod; opt in via .env.local to test
// loops in dev).
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    if (process.env.SATURN_BACKGROUND !== "1") return;
    const { startBackground } = await import("./lib/background.server");
    startBackground();
}
