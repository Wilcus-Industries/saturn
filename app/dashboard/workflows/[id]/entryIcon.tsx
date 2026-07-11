"use client";

import McpLogo from "@/app/dashboard/mcpLogo";
import { CATEGORY_STYLES, type CatalogEntry } from "@/lib/workflow";

// icon shown before an entry's label in toolbox chips, the drag-spawn ghost
// and node headers: mcp favicon > skill emoji > the "::" category glyph
export default function EntryIcon({ entry }: { entry: CatalogEntry }) {
    if (entry.logoDomain) return <McpLogo domain={entry.logoDomain} name={entry.label} size={16} />;
    if (entry.emoji) return <span className={"text-sm leading-none"}>{entry.emoji}</span>;
    return <span className={CATEGORY_STYLES[entry.category].text}>::</span>;
}
