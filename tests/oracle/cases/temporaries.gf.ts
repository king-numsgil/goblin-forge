// A temporary dies at the end of the full-expression that made it, in reverse
// order of creation.
export function main(): i32 {
    const a: string = "a" + "a";
    {
        const joined: string = a + ("b" + "b");
        console.log(joined);
    }
    console.log(a);
    return 0;
}
