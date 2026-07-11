import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getActivation } from "@/lib/subscription";
import Connect from "./connect";

// signed-in users skip the connect step entirely — the redirect runs during
// this server render, so the connect UI is never sent to the client; users
// with a saved activation level skip activation too
export default async function Onboard() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (session?.user) {
        redirect((await getActivation(requestHeaders)) ? "/dashboard" : "/activate");
    }
    return <Connect />;
}
