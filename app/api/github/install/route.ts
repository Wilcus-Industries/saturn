// GitHub App install start. Signed-in user clicks "Install on GitHub" on the
// settings card → here. We mint a per-attempt state nonce (httpOnly cookie,
// mirrors app/api/mcp/oauth/callback state-nonce convention), then bounce to the
// app's installations/new page carrying that nonce as `state`. GitHub echoes it
// back to /api/github/callback where it's checked against the cookie — binding
// the install to the session that started it. Env unset → back to settings with
// an error (feature not configured).
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { baseUrl } from "@/lib/subscription";

export const dynamic = "force-dynamic";

// name shared with the callback route; keep the two in sync
export const GITHUB_STATE_COOKIE = "github_install_state";

export async function GET() {
    const settingsUrl = `${baseUrl}/dashboard/settings`;

    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return NextResponse.redirect(`${baseUrl}/onboard`);

    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug || !process.env.GITHUB_APP_CLIENT_ID || !process.env.GITHUB_APP_CLIENT_SECRET) {
        return NextResponse.redirect(
            `${settingsUrl}?github_error=${encodeURIComponent("GitHub App is not configured")}`,
        );
    }

    // per-attempt nonce, verified against the echoed `state` in the callback
    const nonce = crypto.randomUUID();
    const store = await cookies();
    store.set(GITHUB_STATE_COOKIE, nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 600, // 10 min
    });

    const target = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(nonce)}`;
    return NextResponse.redirect(target);
}
