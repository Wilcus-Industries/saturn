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

// WebKit's default action for Backspace outside a text field is history-back —
// and on a Mac keyboard the Delete key IS Backspace. There is no browser chrome
// here and no page wants it, so it is killed once, globally, rather than in
// every keydown handler. In <head> and not an effect because a keypress during
// the hydration window would still navigate; capture phase so it lands before
// any handler, but preventDefault alone — propagation continues, so the
// designer's own Backspace/Delete branch still deletes the selection.
const BACKSPACE_SCRIPT =
    `addEventListener("keydown",function(e){var t=e.target||{};if(e.key==="Backspace"&&!t.isContentEditable&&!/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||""))e.preventDefault()},true)`;

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
                <script dangerouslySetInnerHTML={{ __html: BACKSPACE_SCRIPT }} />
            </head>
            <body className="min-h-full flex flex-col">
                {children}
            </body>
        </html>
    );
}
