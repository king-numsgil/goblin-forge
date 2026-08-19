// Capturing `this` costs nothing. The closure reads and writes the object
// through the receiver the method already had, so the trace is the one the
// method would print with the closure removed.
function apply(f: LocalFn<() => void>): void {
    f();
}

class Named {
    name: string;

    constructor(name: string) {
        this.name = name;
    }

    rename(): void {
        apply(() => {
            this.name = "z" + "9";
        });
    }
}

export function main(): i32 {
    const a: Named = new Named("a" + "1");
    console.log(a.name);
    a.rename();
    console.log(a.name);
    return 0;
}
