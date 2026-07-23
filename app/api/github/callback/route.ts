// GitHub App OAuth callback ("Callback URL" in the app settings; "Request user
// authorization during installation" must be ON). GitHub sends the user here
// after they pick repos, with ?code&state&installation_id&setup_action. We:
//   1. require a session (the same user who started the install),
//   2. check the echoed `state` against the nonce cookie (forgery guard),
//   3. exchange the code for a user access token (fixed URL, env credentials),
//   4. call GET /user/installations with that token and confirm the returned
//      installation_id is one the user actually controls — the binding proof
//      that stops anyone from claiming a foreign installation id,
//   5. upsert the github_installation row (owner + display login).
// The token is used in-memory only, never stored or logged. Any failure →
// settings with a short ?github_error, rendered inline on the card.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { upsertInstallation } from "@/lib/githubApp.server";
import { baseUrl, getSessionCached } from "@/lib/subscription";
import { GITHUB_STATE_COOKIE } from "../install/route";

export const dynamic = "force-dynamic";

// matches lib/github.server.ts USER_AGENT (GitHub rejects requests without one)
const USER_AGENT = "Saturn-Workflows (https://saturn.wilcus.com)";

const settingsUrl = `${baseUrl}/dashboard/settings`;

function errorRedirect(message: string) {
    return NextResponse.redirect(`${settingsUrl}?github_error=${encodeURIComponent(message)}`);
}

export async function GET(request: Request) {
    // getSessionCached, not auth.api.getSession — self-hosted synthetic owner
    // must be able to complete the binding (see install route)
    const session = await getSessionCached();
    if (!session?.user) return NextResponse.redirect(`${baseUrl}/onboard`);

    const clientId = process.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return errorRedirect("GitHub App is not configured");

    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const state = params.get("state");

    // state nonce must match the cookie set by /api/github/install — clear it
    // after the check either way so it can't be replayed
    const store = await cookies();
    const cookieState = store.get(GITHUB_STATE_COOKIE)?.value;
    store.delete(GITHUB_STATE_COOKIE);
    if (!state || !cookieState || state !== cookieState) {
        return errorRedirect("Start the install from the GitHub App card in settings");
    }

    if (!code) return errorRedirect("GitHub did not return an authorization code");

    // installation id GitHub claims this install produced — trusted only after
    // it's confirmed present in the user's own /user/installations list below
    const installationId = Number(params.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
        return errorRedirect("GitHub did not return a valid installation id");
    }

    // exchange the code for a user access token — fixed URL, nothing
    // request-derived shapes the fetch target
    let accessToken: string;
    try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                "user-agent": USER_AGENT,
            },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        });
        const data = (await res.json()) as { access_token?: string };
        if (!res.ok || !data.access_token) return errorRedirect("GitHub token exchange failed");
        accessToken = data.access_token;
    } catch {
        return errorRedirect("Could not reach GitHub to exchange the code");
    }

    // confirm the user actually controls this installation. Paginate the
    // installations they can see; the id must appear or the request is forged.
    let matched: { account_login: string } | null = null;
    try {
        for (let page = 1; page <= 10; page++) {
            const res = await fetch(
                `https://api.github.com/user/installations?per_page=100&page=${page}`,
                {
                    headers: {
                        authorization: `Bearer ${accessToken}`,
                        accept: "application/vnd.github+json",
                        "x-github-api-version": "2022-11-28",
                        "user-agent": USER_AGENT,
                    },
                },
            );
            if (!res.ok) return errorRedirect("Could not verify the installation with GitHub");
            const data = (await res.json()) as {
                installations?: { id?: number; account?: { login?: string } }[];
            };
            const list = Array.isArray(data.installations) ? data.installations : [];
            const hit = list.find((i) => i.id === installationId);
            if (hit) {
                matched = { account_login: hit.account?.login ?? "" };
                break;
            }
            if (list.length < 100) break; // last page
        }
    } catch {
        return errorRedirect("Could not verify the installation with GitHub");
    }

    if (!matched) return errorRedirect("That installation is not linked to your GitHub account");

    try {
        await upsertInstallation(installationId, session.user.id, matched.account_login);
    } catch {
        return errorRedirect("Could not save the installation");
    }

    return NextResponse.redirect(`${settingsUrl}?github=connected`);
}
