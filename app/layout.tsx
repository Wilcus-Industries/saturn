import type { Metadata } from "next";
import {Geist, Geist_Mono} from "next/font/google";
import "./globals.css";

// next/font downloads these at BUILD time and emits them into the export as
// static assets, so nothing is fetched from Google at runtime — which is what
// makes them work inside the Tauri WebView under a `default-src 'self'` CSP.
const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = { title: "Saturn" };

// Two WebKit default actions that no page here wants, killed once instead of in
// every handler. Same shape for both: <head> and not an effect, because an event
// during the hydration window would still fire the default; capture phase so it
// lands before any handler; preventDefault only, so propagation — and the
// designer's own Backspace/Delete branch — still runs.
//
// Backspace outside a text field is history-back, and on a Mac keyboard the
// Delete key IS Backspace — there is no browser chrome here, so there is nothing
// to go back to. The WebView's context menu is the same kind of leak: Reload and
// Inspect Element on a right-click are not part of this app. Both are gated on
// the same "target is not a text field" test, so a real input keeps Backspace and
// its native Cut/Copy/Paste/Look Up menu.
const EDITABLE = `function(t){return t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||"")}`;
const DEFAULTS_SCRIPT =
    `(function(){var editable=${EDITABLE};` +
    `addEventListener("keydown",function(e){if(e.key==="Backspace"&&!editable(e.target||{}))e.preventDefault()},true);` +
    `addEventListener("contextmenu",function(e){if(!editable(e.target||{}))e.preventDefault()},true)})()`;

export default function RootLayout({
                                       children,
                                   }: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html
            lang="en"
            suppressHydrationWarning
            className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
            <head>
                <script dangerouslySetInnerHTML={{ __html: DEFAULTS_SCRIPT }} />
            </head>
            <body className="min-h-full flex flex-col">
                {children}
            </body>
        </html>
    );
}
