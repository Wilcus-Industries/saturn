import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserRegistry } from "@/lib/registry.server";
import { getSandboxStatuses } from "@/lib/sandbox.server";
import { getActivation, getSessionCached, limitsFor } from "@/lib/subscription";
import DeleteSandboxButton from "./deleteSandboxButton";
import SandboxControls from "./sandboxControls";
import SandboxModal from "./sandboxModal";

// format a MB cap as GB when it's a whole number of gigabytes, else MB
function formatDiskCap(mb: number): string {
    return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

// persistent per-user linux sandboxes; session check lives here, not the layout
export default async function Sandboxes() {
    const requestHeaders = await headers();
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    const registry = await getUserRegistry(session.user.id);
    const sandboxes = registry.filter((entry) => entry.kind === "sandbox");
    const statuses = await getSandboxStatuses(sandboxes.map((s) => s.id));
    const diskCap = limitsFor(await getActivation(requestHeaders)).sandboxDiskMb;

    // if the runtime isn't configured, every status reports configured:false
    const unconfigured = sandboxes.some((s) => statuses.get(s.id)?.configured === false);

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Sandboxes</h1>

            <p className={"font-mono text-sm text-gray-400"}>
                persistent linux environments your agents can code and run commands in — attach
                one to an agent&apos;s sandbox port in the workflow designer.
            </p>

            {unconfigured && (
                <p className={"font-mono text-sm text-amber-400"}>
                    sandbox runtime is not configured on this server
                </p>
            )}

            {sandboxes.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no sandboxes yet — create one to get started
                </p>
            )}

            <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
                {sandboxes.map((entry) => {
                    const status = statuses.get(entry.id);
                    const configured = status?.configured !== false;
                    const running = configured && (status?.running ?? false);
                    const diskMb = status?.diskMb ?? null;

                    return (
                        <div
                            key={entry.id}
                            className={`flex min-h-40 flex-col gap-2 border border-foreground/15 p-4
                                transition-colors duration-200 hover:border-foreground/40`}
                        >
                            <div className={"flex items-start gap-3"}>
                                <span
                                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                                        running
                                            ? "animate-pulse bg-green-500"
                                            : "bg-gray-500"
                                    }`}
                                    aria-hidden
                                />
                                <div className={"min-w-0 flex-1"}>
                                    <span className={"block truncate font-mono text-sm"}>
                                        {entry.name}
                                    </span>
                                    <span className={"font-mono text-xs text-gray-400"}>
                                        {running ? "running" : "stopped"}
                                    </span>
                                </div>
                            </div>

                            {entry.description && (
                                <p
                                    className={`line-clamp-3 font-mono text-xs whitespace-pre-wrap
                                        text-gray-400`}
                                >
                                    {entry.description}
                                </p>
                            )}

                            <div
                                className={`mt-auto flex items-center gap-3 border-t
                                    border-foreground/15 pt-2 font-mono text-xs text-gray-400`}
                            >
                                <span>
                                    {diskMb === null
                                        ? `up to ${formatDiskCap(diskCap)}`
                                        : `${diskMb} MB used / ${formatDiskCap(diskCap)}`}
                                </span>
                                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                    <SandboxModal entry={entry} />
                                    <DeleteSandboxButton id={entry.id} />
                                </div>
                            </div>

                            {configured && (
                                <div
                                    className={"flex items-center justify-end border-t border-foreground/15 pt-2"}
                                >
                                    <SandboxControls id={entry.id} running={running} />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <SandboxModal />
        </div>
    );
}
