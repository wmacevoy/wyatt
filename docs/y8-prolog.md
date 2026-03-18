# y8-prolog — Ephemeral reactive Prolog

y8-prolog is a Prolog dialect designed for reactive systems.
Rules are the program.  Facts are the state.  Signals flow
through, trigger reactions, and vanish — no pollution, no
cleanup.  Predicates can be selectively or globally frozen
for security and parallelism.

Same engine in JavaScript, Python, and C.  ~300 lines each.
Zero dependencies.

## Core ideas

### Facts are state, rules are logic

```prolog
% State (dynamic — changes at runtime)
temperature(kitchen, 22).
temperature(bedroom, 18).

% Logic (static — loaded once)
cold(Room) :- temperature(Room, T), T < 20.
```

`assert` and `retract` mutate state.  Rules don't change
after load (and can be frozen to enforce this).

### Ephemeral — scoped assertion

`ephemeral(Term)` asserts `Term`, runs the continuation, then
retracts `Term` — regardless of success or failure.  The fact
exists only for the duration of the query.

```prolog
handle_signal(From, Fact) :-
    ephemeral(signal(From, Fact)),
    react.
```

After `handle_signal` completes, `signal(From, Fact)` is gone.
No database write.  No cleanup needed.  This is y8-prolog's
equivalent of a local variable in a transaction.

### React — pattern-matched signal processing

```prolog
react :- signal(From, reading(From, Type, Val, Ts)),
         trusted(From),
         retractall(reading(From, Type, _OldV, _OldTs)),
         assert(reading(From, Type, Val, Ts)),
         send(dashboard, reading(From, Type, Val, Ts)).
```

`react` fires when a signal matches.  It can update state
(`retractall` + `assert`), check authorization (`trusted`),
and produce outgoing messages (`send`).  Multiple `react`
clauses handle different signal types — Prolog's
pattern matching dispatches automatically.

### Send — captured outgoing messages

`send(Target, Message)` doesn't transmit anything.  It
appends `{target, message}` to an internal list.
`queryWithSends` collects them:

```javascript
var result = engine.queryWithSends(
    compound("handle_signal", [atom("sensor1"), reading])
);
// result.sends = [{target: "dashboard", fact: reading(...)}]
// No side effects.  Signal already gone.  Sends collected.
```

The application decides what to do with the sends — push to
WebSocket, write to a queue, log.  The Prolog rules never
touch I/O directly.

### The ephemeral/react/send pattern

```
signal arrives
  → ephemeral(signal(...))     assert temporarily
  → react                      pattern match + decide
    → retractall/assert         update persistent state
    → send(target, message)     capture outgoing messages
  → signal retracts             automatic cleanup
  → sends returned              application handles I/O
```

This is zero-cost message passing through the rule engine.
No database writes for the signal itself.  Persistent state
updates (`retractall`/`assert`) are the only mutations.

## Freezing: fossilize and mineralize

### fossilize — global freeze

```javascript
fossilize(engine);
```

All clauses become immutable.  `assert`, `retract`, `addClause`
fail.  Only `ephemeral` survives.  The engine becomes a pure
function: signals in, decisions out.

**Use case:** parallel workers.  A thousand instances run the
same frozen rules against different signals with zero
coordination.  Fork the engine, not the database.

### mineralize — selective freeze

```prolog
mineralize(react/0).
mineralize(threshold/4).
mineralize(trusted_feed/1).
```

Specific predicates become immutable.  Everything else stays
dynamic.  Mineralization is one-way — you can't un-mineralize.

**Use case:** long-running systems.  Lock the rules and access
control.  Let data (`price/3`, `reading/4`) flow freely.

```prolog
% This succeeds (price is not mineralized):
assert(price(btc, 67432.50M)).

% This fails (react is mineralized):
assert(react :- true).
```

### Security model

```
┌─────────────────────────────────────────┐
│  Fossilized: everything frozen          │
│  ┌──────────────────────────────────┐   │
│  │  Mineralized: selected frozen    │   │
│  │  ┌───────────────────────────┐   │   │
│  │  │  Dynamic: normal Prolog   │   │   │
│  │  │  assert/retract work      │   │   │
│  │  └───────────────────────────┘   │   │
│  └──────────────────────────────────┘   │
│  Ephemeral: always works (scoped)       │
└─────────────────────────────────────────┘
```

Fossilize is the outer boundary.  Mineralize carves out
immutable zones within.  Ephemeral passes through all
boundaries — it's scoped to the query, not the database.

## Reactive layer

Built on a signal/memo/effect runtime (~80 lines):

```javascript
var reactive = createReactiveEngine(engine);

// Signal: mutable value that tracks dependencies
var count = createSignal(0);

// Memo: derived value, recomputes when dependencies change
var doubled = createMemo(function() { return count() * 2; });

// Query: Prolog query that recomputes when facts change
var cold = createQuery(engine, "cold(Room).");

// Bump: notify the reactive system that facts changed
reactive.bump();
// → cold rooms recompute automatically
```

`createQuery` bridges Prolog and reactive: the query result
is a reactive value that updates when the engine's facts
change.

## Term representation

| Language | Atom | Compound | Number | Variable |
|----------|------|----------|--------|----------|
| JS | `{type:"atom", name}` | `{type:"compound", functor, args}` | `{type:"num", value, repr?}` | `{type:"var", name}` |
| Python | `("atom", name)` | `("compound", functor, (args,))` | `("num", value)` or `("num", value, repr)` | `("var", name)` |
| C | 32-bit tagged value (tag bits 31:30, payload 29:0) | | | |

The optional `repr` field on num terms preserves QJSON notation
(`"67432.50M"`, `"42N"`) through the full round-trip.

## CPS execution model

```
solve(goals, subst, counter, depth, onSolution)
```

Continuation-passing style.  No generators.  No stack frames
to manage.  Backtracking is just calling the next continuation.

- `goals` — list of goals remaining to prove
- `subst` — substitution map (variable bindings)
- `counter` — fresh variable counter
- `depth` — recursion depth (for limits)
- `onSolution` — callback when a solution is found

`queryFirst` uses exception-based early exit.
`query` collects all solutions up to a limit.
`queryWithSends` collects solutions + outgoing messages.

## Builtins

| Builtin | Purpose |
|---------|---------|
| `assert/1` | Add a fact to the database |
| `retract/1` | Remove first matching fact |
| `retractall/1` | Remove all matching facts |
| `ephemeral/1` | Scoped assert (retract after query) |
| `send/2` | Capture outgoing message |
| `findall/3` | Collect all solutions into a list |
| `not/1` | Negation as failure |
| `is/2` | Arithmetic evaluation |
| `>/2`, `</2`, `>=/2`, `=</2` | Arithmetic comparison |
| `==/2`, `\==/2` | Term equality/inequality |
| `=/2` | Unification |
| `call/1` | Call a term as a goal |
| `write/1` | Append to output buffer |
| `member/2` | List membership |
| `append/3` | List append |
| `length/2` | List length |
| `mineralize/1` | Freeze a predicate (from Prolog) |
| `path_segments/2` | URL path → atom list |
| `field/3` | JSON object field extraction |

## Persistence

```javascript
persist(engine, adapter);
```

Six-method adapter interface:

```
setup()                      — CREATE TABLE IF NOT EXISTS
insert(key, functor, arity)  — mirror assert to storage
remove(key)                  — mirror retract to storage
all(predicates?)             — restore facts on startup
commit()                     — flush to disk
close()                      — release resources
```

Adapters: SQLite (`persist-sqlite`), SQLCipher (`persist-sqlcipher`),
PostgreSQL (`persist-pg`), WASM SQLite (`persist-wasm`).

QSQL adapter adds interval-projected typed columns for query
pushdown.  See `docs/qsql.md`.

Ephemeral facts bypass persistence — they live in memory only.
Only `assert`/`retract` touch the database.

## Implementations

| Language | Engine | Reactive | Persist | Lines |
|----------|--------|----------|---------|-------|
| JavaScript | `prolog-engine.js` | `reactive-prolog.js` | `persist.js` | ~300 + 80 + 100 |
| Python | `prolog.py` | `reactive_prolog.py` | `persist.py` | ~300 + 80 + 100 |
| C (embed) | `y8.c` (QuickJS + SQLite) | via JS | via JS | ~400 |

The C embed runs the JS engine inside QuickJS.  Same rules,
same behavior, single binary.

## Example: IoT signal processing

```prolog
% Rules (loaded once, then mineralized)
trusted(sensor1).
trusted(sensor2).
threshold(temperature, above, 30, overheat_alert).

react :- signal(From, reading(From, Type, Val, Ts)),
         trusted(From),
         retractall(reading(From, Type, _V, _T)),
         assert(reading(From, Type, Val, Ts)).

react :- signal(_From, reading(_Src, Type, Val, _Ts)),
         threshold(Type, above, Limit, Alert),
         Val > Limit,
         send(alerts, Alert).

% Freeze the rules
mineralize(react/0).
mineralize(trusted/1).
mineralize(threshold/4).

% Signals arrive at runtime (ephemeral)
handle_signal(From, Fact) :-
    ephemeral(signal(From, Fact)),
    react.
```

```javascript
// Application loop
var result = engine.queryWithSends(
    compound("handle_signal", [atom("sensor1"),
        compound("reading", [atom("sensor1"),
            atom("temperature"), num(35), num(1710000000)])])
);
// result.sends = [{target: "alerts", fact: overheat_alert}]
// reading(sensor1, temperature, 35, 1710000000) is now in the DB.
// The signal is gone.
```
