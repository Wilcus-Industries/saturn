// Lifecycle owner for in-process background work (cron scheduler + Discord
// gateway + Telegram long-poller + sandbox idle reaper), started once from
// instrumentation.ts on production server boot. The globalThis guard survives
// dev-HMR module reloads; the process-level signal hooks make shutdown
// best-effort — in-flight runs die with the process and the runner's janitor
// sweep marks the stranded rows.
import { startScheduler, stopScheduler } from "@/lib/scheduler.server";
import { startGateway, stopGateway } from "@/lib/gateway.server";
import { startTelegram, stopTelegram } from "@/lib/telegram.server";
import { startSandboxReaper, stopSandboxReaper } from "@/lib/sandbox.server";

declare global {
    var __saturnBackground: boolean | undefined;
}

export function startBackground() {
    if (globalThis.__saturnBackground) return;
    globalThis.__saturnBackground = true;
    console.log("[background] starting in-process scheduler + gateway + telegram + sandbox reaper");
    startScheduler();
    startGateway();
    startTelegram();
    startSandboxReaper();
    const stop = (sig: string) => {
        console.log(`[background] ${sig} — stopping scheduler + gateway + telegram + sandbox reaper`);
        stopScheduler();
        stopGateway();
        stopTelegram();
        stopSandboxReaper();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
}
