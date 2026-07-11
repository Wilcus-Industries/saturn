"use client";

import { useState } from "react";

const EMOJI = [
    "⚙️", "🤖", "📬", "🔍", "📊", "🧹", "📰", "💾",
    "🔔", "🧪", "📦", "🌐", "🗓️", "✉️", "🧠", "🪝",
    "📈", "🛰️", "🧾", "🔁", "🗃️", "🚨", "🏷️", "🌙",
];

// emoji glyphs don't recolor, so selection reads as a solid bg-foreground tile
export default function EmojiGrid({ initial = "⚙️" }: { initial?: string }) {
    const [selected, setSelected] = useState(initial);

    return (
        <>
            <div className={"grid grid-cols-8 gap-1"}>
                {EMOJI.map((emoji) => (
                    <button
                        key={emoji}
                        type={"button"}
                        onClick={() => setSelected(emoji)}
                        aria-pressed={emoji === selected}
                        aria-label={emoji}
                        className={`p-1.5 text-lg transition-colors duration-200
                            ${emoji === selected ? "bg-foreground" : "hover:bg-foreground/10"}`}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
            <input type={"hidden"} name={"emoji"} value={selected} />
        </>
    );
}
