import Spinner from "@/app/dashboard/spinner";

export default function Loading() {
    return (
        <div role={"status"} className={"flex justify-center py-24 font-mono text-2xl text-gray-400"}>
            <Spinner />
            <span className={"sr-only"}>Loading</span>
        </div>
    );
}
