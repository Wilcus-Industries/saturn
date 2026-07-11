import Image from "next/image";
import designerShot from "@/public/demo/designer.png";

// the demo screenshot framed as a designer window — mono title bar with
// outline dots (monochrome, not traffic lights) over the real canvas capture
export default function DemoWindow() {
    return (
        <figure className={"mt-6 border border-foreground bg-background"}>
            <figcaption className={"flex items-center gap-2 border-b border-foreground px-3 py-1.5 font-mono text-xs"}>
                <span>:: designer — equity_alert</span>
                <span aria-hidden className={"ml-auto flex gap-1.5"}>
                    <span className={"size-2 rounded-full border border-foreground"} />
                    <span className={"size-2 rounded-full border border-foreground"} />
                    <span className={"size-2 rounded-full border border-foreground"} />
                </span>
            </figcaption>
            <Image
                src={designerShot}
                alt={"Saturn workflow designer: a start node wired through a Robinhood MCP quote tool into an if branch that prints Over 200 or Under 200."}
                placeholder={"blur"}
                sizes={"(max-width: 1024px) 100vw, 960px"}
                className={"w-full h-auto"}
            />
        </figure>
    );
}
