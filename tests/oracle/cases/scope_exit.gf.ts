// Scope exit order: values are destroyed in reverse order of construction.
export function main(): i32 {
  const a: string = "a" + "1";
  const b: string = "b" + "2";
  const c: string = "c" + "3";
  console.log(c);
  return 0;
}
