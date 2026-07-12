import Link from "next/link";

// onboarding checklist — renders only while at least one step is still pending
// (returns null once every step is done)
export type ChecklistStep = { label: string; href: string; done: boolean };

export default function GettingStarted({ steps }: { steps: ChecklistStep[] }) {
    if (steps.every((s) => s.done)) return null;

    const doneCount = steps.filter((s) => s.done).length;

    return (
        <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <h2 className={"font-mono text-xl"}>Getting started</h2>
            <p className={"font-mono text-sm text-gray-400"}>
                {doneCount} of {steps.length} done
            </p>
            <div className={"flex flex-col gap-3"}>
                {steps.map((step) => (
                    <div
                        key={step.label}
                        className={"flex items-center gap-3 font-mono text-sm"}
                    >
                        {step.done ? (
                            <span className={"h-3 w-3 shrink-0 bg-green-500"} />
                        ) : (
                            <span className={"h-3 w-3 shrink-0 border border-foreground/15"} />
                        )}
                        {step.done ? (
                            <span className={"text-gray-400 line-through"}>{step.label}</span>
                        ) : (
                            <Link href={step.href} className={"text-blue-400"}>
                                {step.label} →
                            </Link>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}
