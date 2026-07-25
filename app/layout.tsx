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

// Sidebar width before first paint. Same trick as a dark-mode flash guard: read
// the preference synchronously in <head> and stamp <html>, so the CSS in
// globals.css has it on the very first frame. localStorage replaces the cookie
// the server used to read — there is no server. Wrapped in try/catch because a
// blocked storage API must not take the whole app down.
const SIDEBAR_SCRIPT =
    `try{if(localStorage.sidebar==="collapsed")document.documentElement.dataset.sidebar="collapsed"}catch(e){}`;

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
                <script dangerouslySetInnerHTML={{ __html: SIDEBAR_SCRIPT }} />
            </head>
            <body className="min-h-full flex flex-col">
                {children}
            </body>
        </html>
    );
}
