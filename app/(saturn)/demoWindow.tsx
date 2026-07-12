import Image from "next/image";
import graphShot from "@/public/demo/graph.png";

// the demo screenshot framed as a designer window — mono title bar with
// outline dots (monochrome, not traffic lights) over the real canvas capture
export default function DemoWindow() {
    return (
        <figure className={"landing-reveal-item w-full max-w-[460px] justify-self-center lg:justify-self-end border border-foreground bg-background"}
                style={{ transitionDelay: "180ms" }}>
            <figcaption className={"flex items-center gap-2 border-b border-foreground px-3 py-1.5 font-mono text-xs"}>
                <span>:: designer — stock_analyst</span>
                <span aria-hidden className={"ml-auto flex gap-1.5"}>
                    <span className={"size-2 rounded-full border border-foreground"} />
                    <span className={"size-2 rounded-full border border-foreground"} />
                    <span className={"size-2 rounded-full border border-foreground"} />
                </span>
            </figcaption>
            <Image
                src={graphShot}
                alt={"Saturn workflow designer: a start node and a literal prompt wired into an agent node with a model node attached, its result printed by a print node."}
                placeholder={"blur"}
                sizes={"(max-width: 1024px) 100vw, 560px"}
                className={"w-full h-auto"}
            />
        </figure>
    );
}
