// A closure inside a closure, reassigning a capture two levels up.
//
// The inner environment does not reach through the outer one: taking a
// reference to something already reached by reference hands back the original
// address, so both levels name the same storage. The release of the old buffer
// therefore belongs to the frame that owns `s`, happens once, and happens at the
// assignment rather than at any scope exit in between.
function apply(f: LocalFn<() => void>): void {
    f();
}

export function main(): i32 {
    let s: string = "a" + "b";
    apply(() => {
        apply(() => {
            s = "c" + "d";
        });
    });
    console.log(s);
    return 0;
}
