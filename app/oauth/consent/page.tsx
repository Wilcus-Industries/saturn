import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// transient auth surface — keep it out of the index
export const metadata: Metadata = {
    title: "Authorize access",
    robots: { index: false, follow: false },
};

// human labels for the OAuth scopes the mcp plugin issues
const SCOPE_LABELS: Record<string, string> = {
    openid: "Confirm your identity",
    profile: "Read your basic profile (name, picture)",
    email: "Read your email address",
    offline_access: "Stay connected while you're away (refresh access)",
};

// Consent screen for the hosted MCP OAuth server. Reached only via
// /api/auth/mcp/authorize (forced through here by proxy.ts + oidcConfig.
// consentPage). Approving/denying posts to better-auth's oAuthConsent endpoint,
// which returns the URL to hand the requesting client back to.
export default async function ConsentPage({
    searchParams,
}: {
    searchParams: Promise<{ consent_code?: string; client_id?: string; scope?: string }>;
}) {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    const { consent_code, client_id, scope } = await searchParams;
    // no live consent request → nothing to authorize
    if (!consent_code || !client_id) redirect("/dashboard");

    const scopes = (scope ?? "openid").split(" ").filter(Boolean);

    // Best-effort client lookup for display. The redirect host is the strongest
    // signal ("this is sending access to <host>"); the registered name is
    // attacker-suppliable via dynamic registration, so it is shown only as a
    // self-reported label. Degrade to the opaque client_id if the better-auth
    // owned table shape ever changes.
    let clientName: string | null = null;
    let redirectHosts: string[] = [];
    try {
        const { rows } = await db.query<{ name: string; redirectUrls: string }>(
            `select name, "redirectUrls" from "oauthApplication" where "clientId" = $1`,
            [client_id],
        );
        if (rows[0]) {
            clientName = rows[0].name?.trim() || null;
            redirectHosts = [
                ...new Set(
                    (rows[0].redirectUrls ?? "")
                        .split(",")
                        .map((u) => u.trim())
                        .filter(Boolean)
                        .map((u) => {
                            try {
                                return new URL(u).host;
                            } catch {
                                return u;
                            }
                        }),
                ),
            ];
        }
    } catch {
        // display falls back to the client_id
    }

    async function decide(formData: FormData) {
        "use server";
        // re-check the session — this is a public POST endpoint
        const actionHeaders = await headers();
        const actionSession = await auth.api.getSession({ headers: actionHeaders });
        if (!actionSession?.user) redirect("/onboard");

        const accept = formData.get("decision") === "approve";
        const code = String(formData.get("consent_code") ?? "");
        if (!code) redirect("/dashboard");

        const result = (await auth.api.oAuthConsent({
            body: { accept, consent_code: code },
            headers: actionHeaders,
        })) as { redirectURI?: string } | null;

        // redirectURI carries the auth code (approve) or an access_denied error
        // (deny); either way it hands the requesting client back
        if (!result?.redirectURI) throw new Error("Consent could not be processed");
        redirect(result.redirectURI);
    }

    return (
        <main
            className={`flex min-h-dvh items-center justify-center bg-background p-6
                text-foreground`}
        >
            <div
                className={`flex w-full max-w-md flex-col gap-6 border border-foreground/15
                    bg-background p-6`}
            >
                <div className={"flex flex-col gap-1"}>
                    <h1 className={"font-mono text-2xl"}>Authorize access</h1>
                    <p className={"font-mono text-sm text-gray-400"}>
                        An application wants to connect to your Saturn account and act as
                        you — read and edit your workflows, and run them (which can call
                        your connected tools and spend your model credits).
                    </p>
                </div>

                <dl className={"flex flex-col gap-3 border border-foreground/15 p-4 font-mono text-sm"}>
                    <div className={"flex flex-col gap-0.5"}>
                        <dt className={"text-xs text-gray-400"}>application (self-reported)</dt>
                        <dd className={"break-words"}>{clientName ?? client_id}</dd>
                    </div>
                    {redirectHosts.length > 0 && (
                        <div className={"flex flex-col gap-0.5"}>
                            <dt className={"text-xs text-gray-400"}>sends access to</dt>
                            <dd className={"break-words text-yellow-500"}>
                                {redirectHosts.join(", ")}
                            </dd>
                        </div>
                    )}
                    <div className={"flex flex-col gap-1"}>
                        <dt className={"text-xs text-gray-400"}>requested permissions</dt>
                        <dd>
                            <ul className={"flex flex-col gap-1"}>
                                {scopes.map((s) => (
                                    <li key={s}>· {SCOPE_LABELS[s] ?? s}</li>
                                ))}
                            </ul>
                        </dd>
                    </div>
                </dl>

                <p className={"font-mono text-xs text-gray-400"}>
                    Signed in as {session.user.email}. Only approve if you started this
                    connection yourself.
                </p>

                <form action={decide} className={"flex gap-3"}>
                    <input type={"hidden"} name={"consent_code"} value={consent_code} />
                    <button
                        type={"submit"}
                        name={"decision"}
                        value={"deny"}
                        className={`flex-1 border border-foreground/30 bg-background p-2 font-mono
                            text-sm transition-colors duration-200 hover:bg-foreground/10`}
                    >
                        Deny
                    </button>
                    <button
                        type={"submit"}
                        name={"decision"}
                        value={"approve"}
                        className={`flex-1 border border-foreground bg-foreground p-2 font-mono
                            text-sm text-background transition-colors duration-200
                            hover:bg-foreground/80`}
                    >
                        Approve
                    </button>
                </form>
            </div>
        </main>
    );
}
