import SaturnScene from "./scene";

// persistent shell for every route that lives under the Saturn sky: the scene
// (art + moons) mounts once and keeps animating while pages swap beneath it.
// Children render outside the scene viewport so pages can append sections
// below the first screen; main is the positioning context for page overlays.
export default function SaturnLayout({ children }: { children: React.ReactNode }) {
    return (
        <main className={"relative"}>
            <div
                data-ascii-bounds
                className={"relative flex h-dvh flex-col items-center justify-center overflow-hidden"}
            >
                <SaturnScene />
                <div className={"absolute bottom-2 right-2"}>
                    <small className={"text-gray-400 font-mono"}>© 2026 Wilcus Industries.</small>
                </div>
            </div>
            {children}
        </main>
    );
}
