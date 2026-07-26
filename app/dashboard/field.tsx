// labelled form control — the one shape every form in the app uses: a label
// wrapping its caption and the control, so clicking the caption focuses it.
// Renders a <textarea> when `rows` is given, an <input> otherwise; every other
// prop (name, type, value/onChange, required, placeholder, autoFocus…) passes
// straight through, so controlled and uncontrolled callers both keep working.
export default function Field({
    label,
    rows,
    ...props
}: React.InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement> & {
    label: string;
    rows?: number;
}) {
    const controlClass = "border border-foreground/15 bg-background p-2 font-mono text-sm";

    return (
        <label className={"flex flex-col gap-1"}>
            <span className={"font-mono text-xs text-gray-400"}>{label}</span>
            {rows === undefined ? (
                <input {...props} className={controlClass} />
            ) : (
                <textarea {...props} rows={rows} className={controlClass} />
            )}
        </label>
    );
}
