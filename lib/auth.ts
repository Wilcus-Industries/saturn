import { betterAuth } from "better-auth";
import { jwt, bearer, mcp } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { seedExampleWorkflow } from "@/lib/exampleWorkflow.server";
import { SELF_HOSTED } from "@/lib/selfhost";

export const auth = betterAuth({
    database: db,
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        },
    },
    session: {
        // signed session-data cookie: skips the per-request session SELECT
        // against Neon. 60s (not the 300 default) because user.plan rides in
        // the cached payload — keeps plan changes and remote sign-outs stale
        // for at most a minute. refreshCache must stay unset (DB-less-only).
        cookieCache: { enabled: true, maxAge: 60 },
    },
    user: {
        additionalFields: {
            // activation level for the non-Stripe tier; input: false keeps it
            // out of the public updateUser surface
            plan: { type: "string", required: false, input: false },
        },
    },
    databaseHooks: {
        user: {
            create: {
                // seed the inactive example workflow for every new user;
                // seedExampleWorkflow never throws — a throw here would
                // propagate into the OAuth sign-in callback
                after: async (user) => {
                    await seedExampleWorkflow(user.id);
                },
            },
        },
    },
    plugins: [
        jwt(),
        bearer(),
        // no Stripe under SELF_HOSTED: the plugin (and its subscription table +
        // auth.api endpoints) is skipped entirely, so nothing may query or call
        // it (see lib/subscription.ts short-circuits).
        ...(SELF_HOSTED
            ? []
            : [
                  stripe({
                      stripeClient: new Stripe(process.env.STRIPE_SECRET_KEY as string),
                      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET as string,
                      subscription: {
                          enabled: true,
                          plans: [
                              { name: "pro", priceId: process.env.STRIPE_PRICE_PRO },
                              { name: "max", priceId: process.env.STRIPE_PRICE_MAX },
                          ],
                      },
                  }),
              ]),
        // OAuth 2.1 authorization server for the hosted workflow-editor MCP
        // server at /mcp (dynamic client registration + PKCE); unauthenticated
        // authorize requests bounce through /onboard and resume after Google
        // sign-in sets the session cookie.
        //
        // consentPage + the /api/auth/mcp/authorize proxy (proxy.ts) force an
        // explicit consent screen for every authorize request. Without it the
        // plugin issues a code silently to any (anonymously registered) client,
        // which a Lax session cookie turns into cross-account token theft.
        mcp({
            loginPage: "/onboard",
            resource: `${process.env.BETTER_AUTH_URL}/mcp`,
            oidcConfig: {
                // loginPage is required by the OIDCOptions type; the plugin
                // overwrites it with the top-level loginPage at runtime
                loginPage: "/onboard",
                consentPage: "/oauth/consent",
            },
        }),
        nextCookies(),
    ], // nextCookies must stay last
});
