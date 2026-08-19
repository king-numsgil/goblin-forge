// Assigning *through* a capture. The old buffer belongs to the enclosing
// frame, so the release happens there and on schedule — the closure is writing
// to the frame's object, not to one of its own.
function apply(f: LocalFn<() => void>): void {
    f();
}

export function main(): i32 {
    let s: string = "a" + "b";
    apply(() => {
        s = "c" + "d";
    });
    console.log(s);
    return 0;
}
