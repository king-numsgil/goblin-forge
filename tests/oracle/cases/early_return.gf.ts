// An early return out of nested scopes releases everything, innermost first.
export function main(): i32 {
    const outer: string = "o" + "1";
    {
        const middle: string = "m" + "2";
        {
            const inner: string = "i" + "3";
            console.log(inner);
            return 0;
        }
    }
}
