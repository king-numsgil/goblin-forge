// A capture is a borrow. The closure reads the enclosing frame's object and
// neither copies it nor destroys it, so the trace is the same one the program
// would print with the closure removed.
function apply(f: LocalFn<() => void>): void {
    f();
}

export function main(): i32 {
    const name: string = "wor" + "ld";
    apply(() => {
        console.log(name);
    });
    console.log(name);
    return 0;
}
