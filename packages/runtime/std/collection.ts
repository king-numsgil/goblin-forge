/**
 * `std/collection` — the containers that are not `T[]`.
 *
 * **This module is real Goblin source**, and it is the first one that is. The
 * rest of the standard library is *ambient*: `std/alloc`, `std/io` and
 * `std/math` are `declare module` blocks resolving to no file, because
 * everything they export is a function the compiler lowers to a call, and
 * `std/linalg` is a set of types the compiler recognises. None of those shapes
 * fits a container.
 *
 * A `HashMap<K, V>` is a **value**: binding it copies, and the binding's scope
 * releases it and everything in it. That needs a layout, a destructor and
 * lowered methods, and an ambient class has none of the three — DECISIONS §20
 * wrote that down as the answer for the day a std module wanted a value type,
 * and this is that day. It is possible now and was not before, because a
 * container is generic and generics arrived (DECISIONS §11.7, §25).
 *
 * So these are ordinary classes compiled into whoever imports them, exactly as
 * a C++ template in a header is. Nothing here is privileged: every line below is
 * something a program could have written itself.
 *
 * ## What is here
 *
 * | Type | What it is |
 * |---|---|
 * | `HashMap<K, V>` | a hash table over a dense entry array; iterable by index |
 * | `HashSet<K>` | the same table with nothing on the other side |
 * | `BinaryHeap<T>` | a priority queue, ordered by a comparison you supply |
 * | `RingBuffer<T>` | a fixed-capacity FIFO over contiguous storage |
 *
 * `T[]` is not here and is not missing: it is the language's `std::vector`,
 * growable and contiguous, and it is what all four of these are built on.
 *
 * ## The three rules everything here obeys
 *
 * **Storage is `T[]`.** Not raw memory from `mi_malloc`, and the reason is
 * ownership rather than taste: `T[]` owns its elements, so the destructor the
 * compiler generates for a container that holds one already releases every key
 * and value in it. A raw `Pointer<T>` would need a destructor to be written, and
 * there is no syntax for writing one.
 *
 * **A key answers `hashOf` and `equalsOf`.** Which every scalar, `boolean`,
 * enum, pointer, `string`, and struct of those already does. A class does not —
 * it has a vtable and slices when copied — so a class key declares `hash(): u64`
 * and `equals(other: Reference<K>): boolean`, which is the extension point and
 * is the same job a `std::hash<T>` specialisation does in C++.
 *
 * **Reading a value out copies it; emptying a slot does not.** `valueAt`,
 * `peek` and `at` hand back a copy, and should — the container keeps its value,
 * so there are two of it afterwards. Where a value genuinely *leaves*, `take`
 * moves it and puts the default in the slot, which is what `RingBuffer.pop`
 * does and what `HashMap.remove` gets from `pop` plus a `move`.
 *
 * `BinaryHeap`'s sift is the one place that copies where it could take, and
 * deliberately: `take` refuses a class — it would leave one whose constructor
 * never ran — so writing the sift with it would stop `BinaryHeap<C>` existing
 * for any class `C`. For a scalar or a POD struct, which is what a simulation's
 * maps and queues hold, a copy is a `memcpy` either way.
 */

/**
 * One key and one value, side by side.
 *
 * Not exported: it is the table's storage, and handing it out would make the
 * layout part of the interface. `keyAt` and `valueAt` are how an entry is read.
 */
interface Entry<K, V> {
    key: K;
    value: V;
}

/**
 * A hash table: `K` to `V`, average O(1).
 *
 *     const orbits = new HashMap<string, f64>();
 *     orbits.set("earth", 1.0);
 *     orbits.set("mars", 1.524);
 *
 *     const au = orbits.getOr("mars", 0.0);
 *     if (orbits.has("venus")) { … }
 *
 * ## The design, in one sentence
 *
 * The entries live **densely** in a `T[]` in insertion order, and a separate
 * power-of-two table of indices is what the hash actually addresses.
 *
 * That is one indirection more than the textbook arrangement, where the keys and
 * values live in the hash table itself, and it is bought for a specific reason:
 * an open-addressed table has to hold a valid `K` and a valid `V` in every
 * *empty* slot, which means `zeroed<K>()` — and `zeroed` refuses a class,
 * because it would produce one whose constructor never ran. Keys and values
 * would have been restricted to non-class types across the board. Here an empty
 * slot is the number zero and no `K` exists until one is inserted.
 *
 * Two things fall out of it, both worth having. Iteration is over a dense array
 * rather than a sparse one, so it costs the number of entries rather than the
 * capacity. And the entries are in **insertion order** — see `keyAt` for exactly
 * how far that promise goes.
 *
 * ## What a key has to be
 *
 * Anything `hashOf` and `equalsOf` answer for: the scalars, `boolean`, enums,
 * pointers, `CString`, `string`, and structs and fixed arrays of those. A
 * **float is not a key** (`GF0407`) — `0.0 === -0.0` with different bits, and
 * `NaN !== NaN` — so quantise to an integer first. A **class** key declares
 * `hash(): u64` and `equals(other: Reference<K>): boolean`.
 *
 * ## What it is not
 *
 * Not thread-safe, and nothing here is. Not resistant to hostile keys: the hash
 * is deterministic and unseeded, which is what a simulation that has to replay
 * identically wants and the opposite of what a public server wants.
 */
export class HashMap<K, V> {
    /** The entries, densely packed. `size` is this array's length. */
    private entries: Entry<K, V>[] = [];

    /**
     * The hash table proper: a power-of-two run of slots, each holding one of
     * three things.
     *
     * | Value | Means |
     * |---|---|
     * | `0` | empty — the probe stops here |
     * | `1` | a tombstone — something was removed; keep probing |
     * | `n ≥ 2` | entry `n - 2` |
     *
     * Biased by two rather than using a maximum-value sentinel for the
     * tombstone, so that nothing here has to name the largest `usize` — which is
     * a different number on a 32-bit target and would be a literal that silently
     * meant something else there.
     */
    private slots: usize[] = [];

    /**
     * Slots holding `1`.
     *
     * Counted rather than derived, because the load a probe actually sees is
     * entries *plus* tombstones: a table full of tombstones probes as if it were
     * full, and rehashing on the entry count alone would never notice.
     */
    private tombstones: usize = 0;

    /** How many entries. */
    get size(): usize {
        return this.entries.length;
    }

    /**
     * Insert `key`, or overwrite the value already under it.
     *
     * The key is only stored when it is new — overwriting leaves the original
     * key in place, exactly as `std::unordered_map::operator[]` does, which
     * matters when two equal keys are distinguishable in some way the equality
     * does not look at.
     */
    set(key: K, value: V): void {
        this.reserveSlots(this.entries.length + 1);
        const mask = this.slots.length - 1;
        let at = cast<usize>(hashOf<K>(key)) & mask;
        // The first tombstone seen, biased by one so that zero means "none".
        // Reusing one is what stops a table that is repeatedly filled and
        // emptied from rehashing on every insert.
        let hole: usize = 0;
        let probes: usize = 0;

        while (probes <= mask) {
            const slot = this.slots[at];
            if (slot === 0) {
                this.entries.push({key: key, value: value});
                if (hole === 0) {
                    this.slots[at] = this.entries.length + 1;
                } else {
                    this.slots[hole - 1] = this.entries.length + 1;
                    this.tombstones = this.tombstones - 1;
                }
                return;
            }
            if (slot === 1) {
                if (hole === 0) {
                    hole = at + 1;
                }
            } else if (equalsOf<K>(this.entries[slot - 2].key, key)) {
                this.entries[slot - 2].value = value;
                return;
            }
            at = (at + 1) & mask;
            probes = probes + 1;
        }
    }

    /** Whether `key` is in the map. */
    has(key: K): boolean {
        return this.indexOf(key) >= 0;
    }

    /**
     * Where `key`'s entry is, or `-1`.
     *
     * The primitive the rest of the reading surface is built from, and the one to
     * use when a value is wanted *and* its absence has to be told from a value
     * that happens to equal the fallback:
     *
     *     const at = orbits.indexOf("mars");
     *     if (at >= 0) {
     *         console.log(`${orbits.valueAt(cast<usize>(at))}`);
     *     }
     *
     * `isize` rather than a `usize` and a separate boolean, because -1 is the
     * spelling C uses for exactly this and there is no optional type here to
     * carry the other answer.
     */
    indexOf(key: K): isize {
        const slot = this.slotOf(key);
        if (slot < 0) {
            return -1;
        }
        return cast<isize>(this.slots[cast<usize>(slot)] - 2);
    }

    /**
     * The value under `key`, or `fallback` when there is none.
     *
     * **A copy.** For an `f64` or a POD struct that is a `memcpy`; for a
     * `string` it allocates. `indexOf` and `valueAt` are the same two loads
     * without the branch, and neither avoids the copy — there is no way to
     * borrow out of a container yet.
     */
    getOr(key: K, fallback: V): V {
        const at = this.indexOf(key);
        if (at < 0) {
            return fallback;
        }
        return this.entries[cast<usize>(at)].value;
    }

    /**
     * The key of entry `index`, which must be less than `size`.
     *
     * **Iteration order is insertion order, until the first `remove`.** After
     * one, it is unspecified: removing swaps the last entry into the hole, which
     * is what keeps removal O(1) and the entries dense, and it necessarily moves
     * one entry from the end to the middle. A map that is only ever added to
     * iterates in the order it was built.
     *
     * Unchecked, like every other index here and in the language.
     */
    keyAt(index: usize): K {
        return this.entries[index].key;
    }

    /** The value of entry `index`. A copy; see {@link getOr}. */
    valueAt(index: usize): V {
        return this.entries[index].value;
    }

    /**
     * Overwrite the value of entry `index`, leaving its key alone.
     *
     * What a read-modify-write wants, without a second probe:
     *
     *     const at = counts.indexOf(word);
     *     if (at >= 0) {
     *         const i = cast<usize>(at);
     *         counts.setAt(i, counts.valueAt(i) + 1);
     *     }
     */
    setAt(index: usize, value: V): void {
        this.entries[index].value = value;
    }

    /**
     * Take `key` out. `true` if it was there.
     *
     * O(1), and it **reorders**: the last entry is moved into the hole. See
     * {@link keyAt} for what that costs and why it is the right trade.
     */
    remove(key: K): boolean {
        const slot = this.slotOf(key);
        if (slot < 0) {
            return false;
        }
        const at = this.slots[cast<usize>(slot)] - 2;
        this.slots[cast<usize>(slot)] = 1;
        this.tombstones = this.tombstones + 1;

        const last = this.entries.length - 1;
        // `pop` **moves** the last entry out, which is the one place a value
        // leaves this container without being copied — the element is going away
        // and there is exactly one of it afterwards.
        const taken = this.entries.pop();
        if (at !== last) {
            // The moved entry's slot still names its old index. Find it by its
            // key — the tombstone just written is a `1` and cannot be mistaken
            // for it — and repoint it before anything reads the table again.
            this.slots[this.slotHolding(taken.key, last)] = at + 2;
            this.entries[at] = move(taken);
        }
        return true;
    }

    /**
     * Drop every entry, keeping the storage.
     *
     * `std::unordered_map::clear`: the capacity survives, so a map that is
     * filled and cleared in a loop allocates once.
     */
    clear(): void {
        while (this.entries.length !== 0) {
            // Popped into a temporary that nothing takes, so the entry — and the
            // key and value in it — is released at the end of the statement.
            this.entries.pop();
        }
        for (let i: usize = 0; i < this.slots.length; i = i + 1) {
            this.slots[i] = 0;
        }
        this.tombstones = 0;
    }

    /**
     * Make room for `count` entries without inserting any.
     *
     * Both halves: the dense array and the slot table. Worth doing when the size
     * is known, because it turns a run of inserts that rehashes a handful of
     * times into one that never does.
     */
    reserve(count: usize): void {
        this.entries.reserve(count);
        this.reserveSlots(count);
    }

    /**
     * Call `f` with every key and value, in the order {@link keyAt} describes.
     *
     * **Do not insert or remove from inside `f`.** The length is read on every
     * iteration, so an insert is a loop that may not end and a remove moves an
     * entry the loop has already passed — the same bargain iterating a
     * `std::vector` strikes, for the same reason.
     */
    forEach(f: LocalFn<(key: K, value: V) => void>): void {
        for (let i: usize = 0; i < this.entries.length; i = i + 1) {
            f(this.entries[i].key, this.entries[i].value);
        }
    }

    /** The slot `key` occupies, or `-1`. */
    private slotOf(key: K): isize {
        if (this.slots.length === 0) {
            return -1;
        }
        const mask = this.slots.length - 1;
        let at = cast<usize>(hashOf<K>(key)) & mask;
        let probes: usize = 0;
        // Bounded by the table size rather than written as a loop that trusts an
        // empty slot to turn up. One always does — the table is never full — and
        // a bug that made it full would otherwise hang instead of returning a
        // wrong answer, which is the harder of the two to find.
        while (probes <= mask) {
            const slot = this.slots[at];
            if (slot === 0) {
                return -1;
            }
            if (slot !== 1 && equalsOf<K>(this.entries[slot - 2].key, key)) {
                return cast<isize>(at);
            }
            at = (at + 1) & mask;
            probes = probes + 1;
        }
        return -1;
    }

    /** The slot naming entry `index`, which is known to be there. */
    private slotHolding(key: K, index: usize): usize {
        const mask = this.slots.length - 1;
        let at = cast<usize>(hashOf<K>(key)) & mask;
        let probes: usize = 0;
        while (probes <= mask) {
            if (this.slots[at] === index + 2) {
                return at;
            }
            at = (at + 1) & mask;
            probes = probes + 1;
        }
        return 0;
    }

    /**
     * Grow the slot table so `count` entries sit at a load factor of 0.7 or
     * below, rehashing if it has to.
     *
     * 0.7 rather than 0.5 or 0.9: linear probing degrades sharply as a table
     * fills — the expected probe count for a successful lookup is
     * `(1 + 1/(1-α))/2`, which is 1.7 at 0.5, 2.2 at 0.7 and 5.5 at 0.9 — and
     * the memory is a `usize` per slot either way. Sixteen is the floor, so a
     * map with three things in it does not rehash on the way there.
     */
    private reserveSlots(count: usize): void {
        // Tombstones count toward the load a probe actually walks, so a table
        // that has been emptied and refilled rehashes on them alone.
        if (this.slots.length !== 0 && (count + this.tombstones) * 10 <= this.slots.length * 7) {
            return;
        }
        let capacity: usize = 16;
        while (count * 10 > capacity * 7) {
            capacity = capacity * 2;
        }
        this.rehash(capacity);
    }

    /** Rebuild the slot table at `capacity`, which must be a power of two. */
    private rehash(capacity: usize): void {
        const slots: usize[] = [];
        slots.reserve(capacity);
        for (let i: usize = 0; i < capacity; i = i + 1) {
            slots.push(0);
        }

        const mask = capacity - 1;
        for (let e: usize = 0; e < this.entries.length; e = e + 1) {
            let at = cast<usize>(hashOf<K>(this.entries[e].key)) & mask;
            // No equality check and no tombstones: every key already in a map is
            // distinct from every other, so the first empty slot is the answer.
            while (slots[at] !== 0) {
                at = (at + 1) & mask;
            }
            slots[at] = e + 2;
        }

        // `move`, not a copy: the table was built here and there is no reason for
        // two of it. Without this the assignment clones the whole run of slots
        // and frees the original, which is a second allocation the size of the
        // table on every rehash.
        this.slots = move(slots);
        this.tombstones = 0;
    }
}

/**
 * A set of `K`: membership, average O(1).
 *
 *     const seen = new HashSet<u64>();
 *     if (seen.add(body.id)) { … }   // true the first time
 *
 * The same table {@link HashMap} uses, and literally so — it holds one, with
 * `boolean` on the other side. That costs one padded byte per entry against a
 * table written out again for the case with no value, and it buys there being
 * one probing implementation in this module rather than two that have to agree.
 *
 * A key is whatever a `HashMap` key is.
 */
export class HashSet<K> {
    private map: HashMap<K, boolean> = new HashMap<K, boolean>();

    /** How many members. */
    get size(): usize {
        return this.map.size;
    }

    /**
     * Put `value` in. `true` if it was not already there.
     *
     * The return is what makes this the "have I seen this" primitive without a
     * second lookup, which is most of what a set is for.
     */
    add(value: K): boolean {
        const fresh = !this.map.has(value);
        this.map.set(value, true);
        return fresh;
    }

    /** Whether `value` is a member. */
    has(value: K): boolean {
        return this.map.has(value);
    }

    /** Take `value` out. `true` if it was there. Reorders; see {@link at}. */
    remove(value: K): boolean {
        return this.map.remove(value);
    }

    /** Member `index`, in insertion order until the first `remove`. */
    at(index: usize): K {
        return this.map.keyAt(index);
    }

    /** Drop every member, keeping the storage. */
    clear(): void {
        this.map.clear();
    }

    /** Make room for `count` members. */
    reserve(count: usize): void {
        this.map.reserve(count);
    }

    /** Call `f` with every member. The caution on `HashMap.forEach` applies. */
    forEach(f: LocalFn<(value: K) => void>): void {
        for (let i: usize = 0; i < this.map.size; i = i + 1) {
            f(this.map.keyAt(i));
        }
    }
}

/**
 * A priority queue: `pop` hands back the element that comes first.
 *
 *     function sooner(a: Event, b: Event): boolean { return a.time < b.time; }
 *
 *     const queue = new BinaryHeap<Event>(sooner);
 *     queue.push(event);
 *     const next = queue.pop();
 *
 * A binary heap in a `T[]`: `push` and `pop` are O(log n), `peek` is O(1), and
 * there is no allocation beyond the array's own growth.
 *
 * ## The order is a function you pass, not a property of `T`
 *
 * `before(a, b)` means "`a` comes out before `b`", and the heap hands back the
 * element nothing comes before. So `(a, b) => a < b` is a min-heap and
 * `(a, b) => a > b` is a max-heap, and ordering by a field needs no wrapper
 * type.
 *
 * A comparison rather than a `lessThan` method on `T`, and unlike the way
 * `hashOf` works — deliberately. There is one sensible equality for a value and
 * usually one sensible hash, so the compiler can answer for those; there is no
 * one sensible *order*, and the same events are queued by time in one place and
 * by priority in another. C++ takes the comparator as a parameter for the same
 * reason.
 *
 * **It is by value.** A `Reference<T>` would be the cheaper signature and is not
 * available for a scalar (`GF0002`: a reference to one machine word is an extra
 * load bought with nothing), so a heap of `i32` could not be spelled at all.
 * Passing by value costs a `memcpy` per comparison for a POD and an allocation
 * for a `string`.
 *
 * ## What sifting costs
 *
 * Moving an element between slots is written as an assignment, so it **copies**
 * — `move(xs[i])` is `GF0001` today. A heap of scalars or POD structs, which is
 * what an event queue holds, pays a `memcpy`; a heap of `string` pays an
 * allocation per level of the sift. Worth knowing before putting owning values
 * in one.
 */
export class BinaryHeap<T> {
    private items: T[] = [];
    private before: (a: T, b: T) => boolean;

    /** `before(a, b)` is "`a` comes out first". */
    constructor(before: (a: T, b: T) => boolean) {
        this.before = before;
    }

    /** How many elements. */
    get size(): usize {
        return this.items.length;
    }

    /**
     * The element that would come out next, without taking it. A copy.
     *
     * Unchecked on an empty heap, like indexing.
     */
    peek(): T {
        return this.items[0];
    }

    /** Put `value` in, and sift it up to where it belongs. */
    push(value: T): void {
        this.items.push(value);
        let at = this.items.length - 1;
        while (at !== 0) {
            const parent = (at - 1) / 2;
            if (!this.before(this.items[at], this.items[parent])) {
                return;
            }
            this.swap(at, parent);
            at = parent;
        }
    }

    /**
     * Take the first element out.
     *
     * The last element is moved to the top and sifted down — the standard
     * arrangement, and the reason a heap needs no hole in the middle of its
     * array. Unchecked on an empty heap.
     */
    pop(): T {
        const last = this.items.length - 1;
        if (last === 0) {
            return this.items.pop();
        }
        const out = this.items[0];
        this.items[0] = this.items[last];
        // The duplicate at the end, released. `pop` moves it into a temporary
        // that nothing takes, so it is destroyed at the end of the statement.
        this.items.pop();
        this.siftDown();
        return out;
    }

    /** Drop everything, keeping the storage. */
    clear(): void {
        while (this.items.length !== 0) {
            this.items.pop();
        }
    }

    /** Make room for `count` elements. */
    reserve(count: usize): void {
        this.items.reserve(count);
    }

    /** Restore the heap property downward from the root. */
    private siftDown(): void {
        const count = this.items.length;
        let at: usize = 0;
        while (true) {
            const left = at * 2 + 1;
            if (left >= count) {
                return;
            }
            const right = left + 1;
            let first = left;
            if (right < count && this.before(this.items[right], this.items[left])) {
                first = right;
            }
            if (!this.before(this.items[first], this.items[at])) {
                return;
            }
            this.swap(at, first);
            at = first;
        }
    }

    /**
     * Exchange two elements.
     *
     * Three copies where a `std::swap` would be three moves, for the reason the
     * class comment gives. The `move` on the way back is the one of the three
     * that can be a move, because `held` is a local.
     *
     * **`take` would remove the other two** — `take(items[a])`, then
     * `items[a] = take(items[b])`, then `items[b] = move(held)` — and it is
     * deliberately not used, because `take` refuses a class (it would leave one
     * whose constructor never ran) and that would stop `BinaryHeap<C>` existing
     * for any class `C`. Trading a capability for a copy on the element types
     * least likely to be in a heap is the wrong way round; a heap of scalars or
     * POD structs, which is what an event queue is, copies by `memcpy` either
     * way.
     */
    private swap(a: usize, b: usize): void {
        const held = this.items[a];
        this.items[a] = this.items[b];
        this.items[b] = move(held);
    }
}

/**
 * A fixed-capacity FIFO over one contiguous run of storage.
 *
 *     const recent = new RingBuffer<Sample>(256);
 *     recent.push(sample);          // false when full
 *     const oldest = recent.pop();
 *
 * The capacity is fixed at construction and the buffer never grows, which is the
 * point rather than a limitation: a ring is what you reach for when the memory
 * has to be bounded — a fixed window of history, a work queue with back
 * pressure, a frame's worth of events. Something that should grow is a `T[]`.
 *
 * `push` returns `false` when full rather than growing or overwriting. Dropping
 * the oldest silently is a policy, and one this cannot pick for you; a caller
 * that wants it writes `if (!ring.push(v)) { ring.pop(); ring.push(v); }`.
 *
 * **`T` may not be a class.** Every slot holds a real `T` at all times, and the
 * free ones hold `zeroed<T>()` — which refuses a class, because it would produce
 * one whose constructor never ran (`GF0002`). Every other type works, `string`
 * and owning structs included. A class fits in one as a `Pointer<C>`, or as a
 * struct with the same fields.
 */
export class RingBuffer<T> {
    private slots: T[] = [];
    /** Where the oldest element is. */
    private first: usize = 0;
    private count: usize = 0;

    constructor(capacity: usize) {
        this.slots.reserve(capacity);
        for (let i: usize = 0; i < capacity; i = i + 1) {
            this.slots.push(zeroed<T>());
        }
    }

    /** How many elements are in it. */
    get size(): usize {
        return this.count;
    }

    /** How many it can hold. Fixed at construction. */
    get capacity(): usize {
        return this.slots.length;
    }

    get isEmpty(): boolean {
        return this.count === 0;
    }

    get isFull(): boolean {
        return this.count === this.slots.length;
    }

    /** Add to the back. `false` — and nothing happens — when it is full. */
    push(value: T): boolean {
        if (this.count === this.slots.length) {
            return false;
        }
        // Writes over a slot that holds a zeroed `T`, whose destructor runs
        // first, which is why the free slots have to hold a real value rather
        // than uninitialised bytes.
        this.slots[this.wrap(this.count)] = value;
        this.count = this.count + 1;
        return true;
    }

    /**
     * Take the oldest element off the front. Unchecked when empty.
     *
     * `take` is exactly this operation and does it in one step: the value comes
     * out and the default goes in, so the slot stays a real value for the
     * destructor that runs when the ring itself goes away, and nothing is
     * copied on the way. Written by hand it was a copy out and then a
     * `zeroed<T>()` back — correct, and an allocation per pop for an owning `T`.
     */
    pop(): T {
        const out = take(this.slots[this.first]);
        this.first = this.wrap(1);
        this.count = this.count - 1;
        return out;
    }

    /** The element `offset` places from the front, without taking it. A copy. */
    at(offset: usize): T {
        return this.slots[this.wrap(offset)];
    }

    /** Drop everything. The storage stays. */
    clear(): void {
        while (this.count !== 0) {
            this.pop();
        }
    }

    /**
     * The slot `offset` places past the front.
     *
     * A subtraction rather than `%`, because the wrap can only ever happen once
     * — `first` is already inside the buffer and `offset` is less than the
     * capacity — and a division is worth avoiding on a path this hot.
     */
    private wrap(offset: usize): usize {
        const at = this.first + offset;
        if (at >= this.slots.length) {
            return at - this.slots.length;
        }
        return at;
    }
}
