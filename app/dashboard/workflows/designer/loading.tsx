import Spinner from "@/app/dashboard/spinner";

// full-screen fallback: the designer route is outside (shell), so it has no
// sidebar and the shell's loading.tsx doesn't apply here
export default function Loading() {
    return (
        <div role={"status"} className={"flex h-dvh items-center justify-center font-mono text-3xl text-gray-400"}>
            <Spinner />
            <span className={"sr-only"}>Loading designer</span>
        </div>
    );
}
