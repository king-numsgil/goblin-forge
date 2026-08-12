//! Writes `packages/backend/js/mir.generated.ts` from the Rust MIR definitions.
//!
//! Run with `cargo run -p goblin-mir --bin gen-bindings`, or
//! `bun run --cwd packages/backend bindings`. The backend's `build` script runs
//! it first, so a normal build cannot produce an addon and a set of bindings
//! that disagree.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let outcome = goblin_mir::bindings::write()?;
    println!(
        "{}: {}",
        if outcome.changed {
            "wrote"
        } else {
            "unchanged"
        },
        outcome.path.display(),
    );
    println!("fingerprint: {:016x}", goblin_mir::schema::fingerprint());
    Ok(())
}
