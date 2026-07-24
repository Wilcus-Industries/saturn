// Lifecycle owner for in-process background work (cron scheduler + Discord
// gateway + Telegram long-poller + sandbox idle reaper), started once from
// instrumentation.ts on production server boot. The globalThis guard survives
// dev-HMR module reloads. There is no shutdown path: every background timer is
// unref'd, in-flight runs die with the process, and the runner's janitor sweep
// marks the stranded rows.
import { startScheduler } from "@/lib/scheduler.server";
import { startGateway } from "@/lib/gateway.server";
import { startTelegram } from "@/lib/telegram.server";
import { startSandboxReaper } from "@/lib/sandbox.server";

declare global {
    var __saturnBackground: boolean | undefined;
}

export function startBackground() {
    if (globalThis.__saturnBackground) return;
    globalThis.__saturnBackground = true;
    console.log(
        "[background] starting in-process scheduler + gateway + telegram + sandbox reaper",
    );
    startScheduler();
    startGateway();
    startTelegram();
    startSandboxReaper();
}
