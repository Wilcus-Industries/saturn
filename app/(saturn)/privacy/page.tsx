import type { Metadata } from "next";
import LegalPage, { LegalSection } from "../legalPage";
import { ORG_NAME, SITE_NAME } from "@/lib/seo";

export const metadata: Metadata = {
    title: "Privacy Policy",
    description: "What data Saturn collects, how it is used, and where it goes.",
    alternates: { canonical: "/privacy" },
};

const CONTACT_EMAIL = "lucas.marta0799@gmail.com";

export default function Privacy() {
    return (
        <LegalPage title={"Privacy Policy"}>
            <LegalSection heading={"1. Who we are"}>
                <p>
                    {SITE_NAME} is operated by {ORG_NAME}. Questions and requests:{" "}
                    <a href={`mailto:${CONTACT_EMAIL}`}
                       className={"underline underline-offset-4 hover:text-foreground transition-colors"}>
                        {CONTACT_EMAIL}
                    </a>.
                </p>
            </LegalSection>
            <LegalSection heading={"2. What we collect"}>
                <ul className={"flex list-disc flex-col gap-1 pl-5"}>
                    <li>Your Google account basics (name, email, avatar) when you sign in.</li>
                    <li>Your subscription status from Stripe; card details never touch our servers.</li>
                    <li>The workflows you build and their run logs.</li>
                    <li>MCP server configurations, including tokens you provide.</li>
                    <li>Your OpenRouter API key, if you set one.</li>
                    <li>Model usage records for credit metering on paid tiers.</li>
                </ul>
            </LegalSection>
            <LegalSection heading={"3. How we use it"}>
                <p>
                    To operate the service: run your workflows, bill subscriptions, enforce
                    tier limits, and provide support. We may also email you at your account
                    address for required service and account messages and for optional
                    product announcements you can opt out of. We show no ads, sell no data,
                    and run no third-party analytics or tracking.
                </p>
            </LegalSection>
            <LegalSection heading={"4. Cookies"}>
                <p>
                    Essential cookies only: your sign-in session and one UI preference
                    (sidebar state). No tracking cookies.
                </p>
            </LegalSection>
            <LegalSection heading={"5. Where data goes"}>
                <ul className={"flex list-disc flex-col gap-1 pl-5"}>
                    <li>Stripe processes payments.</li>
                    <li>Google handles sign-in; your browser also loads service logos from Google&apos;s favicon service.</li>
                    <li>OpenRouter receives prompt content when your workflows call models.</li>
                    <li>Neon hosts our database, Vercel hosts the application.</li>
                </ul>
                <p>
                    Workflow data is also sent to the MCP servers and webhooks you configure,
                    where you direct it.
                </p>
            </LegalSection>
            <LegalSection heading={"6. Secrets"}>
                <p>
                    API keys and tokens are stored server side and are never sent to your
                    browser.
                </p>
            </LegalSection>
            <LegalSection heading={"7. Retention and deletion"}>
                <p>
                    Run logs keep the newest 50 runs per workflow. Everything else is kept
                    while your account exists. Email us to delete your account and its data.
                </p>
            </LegalSection>
            <LegalSection heading={"8. Changes"}>
                <p>Updates are posted on this page.</p>
            </LegalSection>
        </LegalPage>
    );
}
