// A by-value parameter is a copy the caller makes and the caller destroys.
function twice(s: string): string {
    return s + s;
}

export function main(): i32 {
    const original: string = "m" + "n";
    const doubled: string = twice(original);
    console.log(original);
    console.log(doubled);
    return 0;
}
