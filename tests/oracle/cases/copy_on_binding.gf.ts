// Binding a value to a second name copies it. Both are released.
export function main(): i32 {
  const source: string = "x" + "y";
  const copy: string = source;
  console.log(copy);
  return 0;
}
