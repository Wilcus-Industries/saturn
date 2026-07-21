"use client";

import { FaTerminal } from "react-icons/fa6";
import McpLogo from "@/app/dashboard/mcpLogo";
import { type CatalogEntry, entryStyles } from "@/lib/workflow";

// icon shown before an entry's label in toolbox chips, the drag-spawn ghost
// and node headers: mcp favicon > sandbox terminal > skill emoji > the "::"
// category glyph. Sandbox chips carry no emoji, so they get the terminal icon
// in their category (lime) color, matching the canvas chip.
export default function EntryIcon({ entry }: { entry: CatalogEntry }) {
    if (entry.logoDomain) return <McpLogo domain={entry.logoDomain} name={entry.label} size={16} />;
    if (entry.category === "sandbox")
        return <FaTerminal className={entryStyles(entry).text} />;
    if (entry.emoji) return <span className={"text-sm leading-none"}>{entry.emoji}</span>;
    return <span className={entryStyles(entry).text}>::</span>;
}
