/**
 * `interface E extends Union` — C's union.
 *
 * The interesting cases are all about *storage being shared*: that the size is
 * the largest member rather than the sum, that the alignment is the strictest
 * member's rather than the largest member's own, and that writing one member
 * is visible through another. The last of those is undefined behaviour in C
 * and is exactly what a union is for at a C boundary, so it is tested rather
 * than avoided.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("layout", () => {
  test("size is the largest member and alignment the strictest", async () => {
    const result = await run(
      "union-layout",
      `interface Small { a: u8; b: u8; }
       interface Wide { a: u64; }
       interface Mixed extends Union { small: Small; wide: Wide; }
       interface AsStruct { small: Small; wide: Wide; }
       export function main(): i32 {
         console.log(\`union  \${sizeOf<Mixed>()} / \${alignOf<Mixed>()}\`);
         console.log(\`struct \${sizeOf<AsStruct>()} / \${alignOf<AsStruct>()}\`);
         return 0;
       }
`,
    );
    // The union is one `u64`; the struct is the two members laid end to end,
    // padded so the `u64` lands on 8.
    expect(result.stdout).toBe("union  8 / 8\nstruct 16 / 8\n");
  });

  test("a union of one byte and one word is word-aligned, not byte-aligned", async () => {
    // The case a `FixedArray<u8, N>` gets wrong: the same size, the wrong
    // alignment, and no diagnostic anywhere.
    const result = await run(
      "union-align",
      `interface Tag extends Union { small: u8; wide: u64; }
       export function main(): i32 {
         console.log(\`\${sizeOf<Tag>()} / \${alignOf<Tag>()}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("8 / 8\n");
  });
});

describe("reading and writing", () => {
  test("every member starts at offset 0, so a write is visible through another", async () => {
    const result = await run(
      "union-overlap",
      `interface Word extends Union { whole: u32; low: u8; }
       export function main(): i32 {
         let w = zeroed<Word>();
         w.whole = 0;
         w.low = 0xAB;
         console.log(\`\${w.low} \${w.whole}\`);
         return 0;
       }
`,
    );
    // Little-endian: the low byte of `whole` is the byte `low` names.
    expect(result.stdout).toBe("171 171\n");
  });

  test("a nested struct member reads through the shared storage", async () => {
    const result = await run(
      "union-nested",
      `interface Header { type: u32; id: u32; }
       interface Payload { type: u32; value: u64; }
       interface Message extends Union { header: Header; payload: Payload; }
       export function main(): i32 {
         let m = zeroed<Message>();
         m.payload.type = 7;
         m.payload.value = 99;
         console.log(\`\${m.header.type} \${m.payload.value}\`);
         return 0;
       }
`,
    );
    // `type` is the common initial sequence — the one cross-member read C
    // actually blesses.
    expect(result.stdout).toBe("7 99\n");
  });
});

describe("making one", () => {
  test("`zeroed` takes the type from the annotation, the argument, or both", async () => {
    // All three spellings work. The contextual one reads best, and is the
    // reason the type argument is optional rather than required.
    const result = await run(
      "union-zeroed-spellings",
      `interface W extends Union { whole: u32; low: u8; }
       export function main(): i32 {
         const a: W = zeroed();
         let b = zeroed<W>();
         let c: W = zeroed<W>();
         b.low = 2;
         c.low = 3;
         console.log(\`\${a.low} \${b.low} \${c.low}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("0 2 3\n");
  });

  test("every byte is zero, not just the first member", async () => {
    // What makes this the right way to hand a union to C: the whole storage is
    // cleared, so no member reads back whatever was on the stack.
    const result = await run(
      "union-zeroed-whole",
      `interface Big extends Union { small: u8; wide: u64; }
       export function main(): i32 {
         const b = zeroed<Big>();
         console.log(\`\${b.wide}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("0\n");
  });

  test("`zeroed` of a class is refused — it would skip the constructor", async () => {
    await expectRejected(
      "union-zeroed-class",
      `class Counter { n: i32 = 7; }
       export function main(): i32 {
         const c = zeroed<Counter>();
         return c.n;
       }
`,
      "GF0002",
    );
  });
});

describe("the shape this was built for", () => {
  test("an `SDL_Event` lays out the way SDL's own header asserts", async () => {
    // Modelled on SDL3's `SDL_events.h`: a union of the event structs, tagged
    // by a `Uint32` at offset 0, with `Uint8 padding[128]` forcing the size.
    // SDL asserts `sizeof(SDL_Event) == 128` at compile time, so that is the
    // number to match — and the alignment is 8 because members carry `Uint64`
    // timestamps, which a byte array of the same size would not give.
    const result = await run(
      "union-sdl",
      `enum SDL_EventType { Quit = 0x100, KeyDown = 0x300, MouseMotion = 0x400 }
       declare namespace SDL_EventType { type Underlying = u32 }

       interface SDL_CommonEvent { type: u32; reserved: u32; timestamp: u64; }
       interface SDL_KeyboardEvent {
         type: u32; reserved: u32; timestamp: u64;
         windowID: u32; which: u32; scancode: u32; key: u32;
         mod_: u16; raw: u16; down: boolean; repeat_: boolean;
       }
       interface SDL_MouseMotionEvent {
         type: u32; reserved: u32; timestamp: u64;
         windowID: u32; which: u32; state: u32;
         x: f32; y: f32; xrel: f32; yrel: f32;
       }

       interface SDL_Event extends Union {
         type: u32;
         common: SDL_CommonEvent;
         key: SDL_KeyboardEvent;
         motion: SDL_MouseMotionEvent;
         padding: FixedArray<u8, 128>;
       }

       export function main(): i32 {
         console.log(\`event \${sizeOf<SDL_Event>()} / \${alignOf<SDL_Event>()}\`);
         console.log(\`key   \${sizeOf<SDL_KeyboardEvent>()} / \${alignOf<SDL_KeyboardEvent>()}\`);

         // What a poll loop does: fill it, read the tag, branch on it.
         let event = zeroed<SDL_Event>();
         event.key.type = SDL_EventType.KeyDown;
         event.key.scancode = 42;

         if (event.type === SDL_EventType.KeyDown) {
           console.log(\`keydown \${event.key.scancode}\`);
         } else {
           console.log("other");
         }
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("event 128 / 8\nkey   40 / 8\nkeydown 42\n");
  });
});

describe("the rules", () => {
  test("an owning member is GF0303", async () => {
    const diagnostic = await expectRejected(
      "union-owning",
      `interface Bad extends Union { n: u32; s: string; }
       export function main(): i32 {
         let b = zeroed<Bad>();
         b.n = 1;
         return 0;
       }
`,
      "GF0303",
    );
    expect(diagnostic.location?.line).toBeGreaterThan(0);
  });

  test("a `T[]` member is refused for the same reason", async () => {
    await expectRejected(
      "union-array-member",
      `interface Bad extends Union { n: u32; xs: i32[]; }
       export function main(): i32 {
         let b = zeroed<Bad>();
         b.n = 1;
         return 0;
       }
`,
      "GF0303",
    );
  });

  test("an object literal cannot build a union — GF0304", async () => {
    await expectRejected(
      "union-literal",
      `interface Word extends Union { whole: u32; low: u8; }
       export function main(): i32 {
         const w: Word = { whole: 1, low: 2 };
         return 0;
       }
`,
      "GF0304",
    );
  });

  test("a plain struct is still a struct, and a literal still builds one", async () => {
    const result = await run(
      "union-struct-unaffected",
      `interface Point { x: i32; y: i32; }
       export function main(): i32 {
         const p: Point = { x: 1, y: 2 };
         console.log(\`\${p.x} \${p.y} \${sizeOf<Point>()}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("1 2 8\n");
  });
});
