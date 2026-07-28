// The two model providers' marks, as PNGs under public/provider_logos/.
//
// Same-origin, so `img-src 'self'` already covers them — a remote logo would
// have meant a CSP edit, and the Google favicon service mcpLogo.tsx uses has no
// entry for a server running on loopback.
//
// Full-colour art, deliberately unlike icons.tsx's currentColor glyphs: these
// are brand marks, and recolouring one to match a theme would just make it
// wrong. The greyed-out tile state is opacity+grayscale applied by the caller,
// which works on an <img> exactly as it does on an <svg>.
const SOURCES: Record<string, string> = {
    openrouter: "/provider_logos/openrouter.png",
    "claude-code": "/provider_logos/claude_code.png",
};

// `className` carries the size — every caller already owns a sizing scale
// (the settings tile, modelLogo's PX map), so there is nothing to invent here.
export default function ProviderLogo({
    id,
    name,
    className = "",
}: {
    id: string;
    name: string;
    className?: string;
}) {
    const src = SOURCES[id];
    if (!src) return null;

    return (
        // plain <img>: next/image has no remotePatterns configured in this app
        // and these are static files in the export, matching mcpLogo.tsx
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt={`${name} logo`}
            draggable={false}
            // pointer-events-none: on a canvas node the logo must never
            // intercept the drag gesture or become a native image drag
            className={`pointer-events-none shrink-0 select-none object-contain ${className}`}
        />
    );
}
