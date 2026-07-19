"use client";

import ActionButton from "@/app/dashboard/actionButton";
import { discoverMcpTools } from "./actions";

// connect / discover-tools submit for an MCP server card. The OAuth hand-off
// must be a real browser navigation (window.location), not a server-action
// redirect() — see the comment on discoverMcpTools.
export default function ConnectButton({ id, label }: { id: string; label: string }) {
    return (
        <form
            className={"ml-auto"}
            action={async (formData: FormData) => {
                const result = await discoverMcpTools(formData);
                if (result?.url) window.location.assign(result.url);
            }}
        >
            <input type={"hidden"} name={"id"} value={id} />
            <ActionButton className={"text-blue-400"}>{label}</ActionButton>
        </form>
    );
}
