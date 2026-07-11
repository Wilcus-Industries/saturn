import { betterAuth } from "better-auth";
import { jwt, bearer } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { db } from "@/lib/db";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY as string);

export const auth = betterAuth({
    database: db,
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        },
    },
    user: {
        additionalFields: {
            // activation level for the non-Stripe tier; input: false keeps it
            // out of the public updateUser surface
            plan: { type: "string", required: false, input: false },
        },
    },
    plugins: [
        jwt(),
        bearer(),
        stripe({
            stripeClient,
            stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET as string,
            subscription: {
                enabled: true,
                plans: [
                    { name: "pro", priceId: process.env.STRIPE_PRICE_PRO },
                    { name: "max", priceId: process.env.STRIPE_PRICE_MAX },
                ],
            },
        }),
        nextCookies(),
    ], // nextCookies must stay last
});
