import Link from "next/link";
import PageTransition from "./pageTransition";

// shared shell for /terms and /privacy: a solid bg-background section pulled
// up over the layout's h-dvh scene viewport (-mt-[100dvh]) so the legal text
// starts at the top of the page instead of below a full screen of Saturn
export default function LegalPage({ title, children }: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <PageTransition>
            <section className={"relative z-10 -mt-[100dvh] min-h-dvh bg-background"}>
                <div className={"mx-auto flex w-full max-w-3xl flex-col gap-8 px-8 py-16"}>
                    <div className={"flex flex-col gap-2"}>
                        <h1 className={"text-4xl font-mono"}>{title}</h1>
                        <p className={"font-mono text-xs text-gray-400"}>Last updated: July 14, 2026</p>
                    </div>
                    {children}
                    <div className={"font-mono text-xs text-gray-400"}>
                        <Link href={"/"} transitionTypes={["nav-back"]}
                              className={"underline underline-offset-4 hover:text-foreground transition-colors"}>
                            Back to Saturn
                        </Link>
                    </div>
                </div>
            </section>
        </PageTransition>
    );
}

export function LegalSection({ heading, children }: {
    heading: string;
    children: React.ReactNode;
}) {
    return (
        <div className={"flex flex-col gap-2"}>
            <h2 className={"font-mono text-lg"}>{heading}</h2>
            <div className={"flex flex-col gap-2 font-sans text-foreground/70"}>{children}</div>
        </div>
    );
}
