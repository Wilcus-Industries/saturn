import HackerText from "./hackerText";

// tier copy + styling shared by /activate and /dashboard/upgrade. Class strings
// must stay literal so Tailwind sees them.
const TIERS = {
    free: {
        title: "Saturn Free",
        price: "$0/mo",
        accent: "",
        hover: "hover:bg-foreground hover:text-background",
        features: [
            "3 workflows",
            "3 MCP server connections",
            "1 memory store",
            "Hourly schedules",
            "1,000 model credits/mo",
            "All features of Saturn, with the flexibility of your own keys.",
        ],
    },
    pro: {
        title: "Saturn Pro",
        price: "$19/mo",
        accent: "pro-glow text-yellow-500",
        hover: "hover:bg-yellow-500 hover:text-black",
        features: [
            "20 workflows",
            "10 MCP server connections",
            "5 memory stores",
            "Schedules down to every 5 minutes",
            "15,000 model credits/mo",
        ],
    },
    max: {
        title: "Saturn Max",
        price: "$79/mo",
        accent: "enchant-glow text-purple-300",
        hover: "hover:bg-purple-500 hover:text-black",
        features: [
            "100 workflows",
            "50 MCP server connections",
            "20 memory stores",
            "Schedules down to every minute",
            "60,000 model credits/mo",
            "Priority access to everything (and new features)",
        ],
    },
} as const;

export type Tier = keyof typeof TIERS;

// button hover inverts relative to the card: on a static card it fills with
// the tier color; inside a hover-inverted card (`group`, interactive only) it
// reverts to the background instead
export const TIER_BUTTON: Record<Tier, string> = {
    free: `w-full p-2 font-mono border border-current
           hover:bg-foreground hover:text-background
           group-hover:hover:bg-background group-hover:hover:text-foreground
           transition-colors duration-200`,
    pro: `w-full p-2 font-mono border border-current
          hover:bg-yellow-500 hover:text-black
          group-hover:hover:bg-background group-hover:hover:text-yellow-500
          transition-colors duration-200`,
    max: `w-full p-2 font-mono border border-current
          hover:bg-purple-500 hover:text-black
          group-hover:hover:bg-background group-hover:hover:text-purple-300
          transition-colors duration-200`,
};

// interactive controls the hover invert and the Max decode effect; children is
// the footer slot (action form, current-plan label, or nothing)
export default function TierCard({
    tier,
    interactive = true,
    children,
}: {
    tier: Tier;
    interactive?: boolean;
    children?: React.ReactNode;
}) {
    const t = TIERS[tier];
    const hacker = tier === "max" && interactive;
    return (
        <div
            {...(hacker ? { "data-hacker-host": true } : {})}
            className={`w-100 max-w-full p-2 flex flex-col gap-3
                        bg-background border-foreground border
                        transition-colors duration-200
                        ${t.accent} ${interactive ? `group ${t.hover}` : ""}`}
        >
            <div className={"flex items-center gap-3 border-b border-current pb-2"}>
                <h1>
                    {tier === "max" ? (
                        <HackerText text={t.title} flashClass={"text-purple-300 group-hover:text-black"} />
                    ) : (
                        t.title
                    )}
                </h1>
                <small className={"ml-auto font-mono"}>
                    {tier === "max" ? (
                        <HackerText text={t.price} flashClass={"text-purple-300 group-hover:text-black"} />
                    ) : (
                        t.price
                    )}
                </small>
            </div>
            <div className={"min-h-32"}>
                <ul>
                    {t.features.map((f) => (
                        <li key={f}>- {f}</li>
                    ))}
                </ul>
            </div>
            {children}
        </div>
    );
}
