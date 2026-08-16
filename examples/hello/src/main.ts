/**
 * The smallest complete Goblin program.
 *
 * `main` is called by the platform C runtime, so it looks like C's: it returns
 * `i32`, and that value becomes the process exit code.
 */

function factorial(n: i32): i32 {
  let result: i32 = 1;
  let i: i32 = 2;
  while (i <= n) {
    result *= i;
    i++;
  }
  return result;
}

export function main(): i32 {
  // 5! is 120, so `echo %ERRORLEVEL%` (or `echo $?`) prints 120.
  return factorial(5);
}
