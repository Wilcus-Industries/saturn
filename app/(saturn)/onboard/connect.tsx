"use client";

import { useState } from "react";
import Link from "next/link";
import { FaGoogle, FaGithub } from "react-icons/fa6";
import { authClient } from "@/lib/auth-client";
import PageTransition from "../pageTransition";

export default function Connect() {
    const [pending, setPending] = useState(false);

    async function signInWithGoogle() {
        setPending(true);
        try {
            // better-auth resolves with { error } instead of throwing; on success
            // the redirect plugin navigates away, so only failures reach the reset
            const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/activate" });
            if (error) setPending(false);
        } catch {
            setPending(false);
        }
    }

    return (
        <PageTransition>
            <div className={"absolute top-5 left-5 right-5 z-10 pl-3 flex flex-col gap-3"}>
                <h1 className={"text-5xl font-mono"}>Connect</h1>
                <p className={"w-full max-w-100 font-sans"}>
                    Choose an account to continue.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    If you already have a Saturn account associated with the provider you
                    will be signed in.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Otherwise your account will be created.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Please, contact Lucas for support <a
                        href={"mailto:lucas.marta0799@gmail.com"}
                        className={"text-blue-400"}>
                    here</a> if needed.
                </p>
                <button className={`w-full max-w-100 p-2 flex items-center gap-3
                                    bg-background border-foreground border
                                    hover:bg-foreground hover:text-background
                                    transition-colors duration-200
                                    disabled:opacity-50 disabled:hover:bg-background
                                    disabled:hover:text-foreground`}
                        onClick={signInWithGoogle}
                        disabled={pending}>
                    <FaGoogle />
                    <h1>{pending ? "Connecting..." : "Continue with Google"}</h1>
                </button>
                <button className={`w-full max-w-100 p-2 flex items-center gap-3
                                    bg-background border-gray-400 border
                                    text-gray-400 cursor-not-allowed`}
                        disabled>
                    <FaGithub />
                    <h1>Continue with GitHub</h1>
                    <small className={"ml-auto font-mono"}>soon</small>
                </button>
                <Link href={"/"} transitionTypes={["nav-back"]} className={"text-blue-400 font-sans"}>
                    Back
                </Link>
            </div>
        </PageTransition>
    );
}
