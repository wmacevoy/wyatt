# y8-prolog-qjson — Prolog as QJSON

Prolog programs are QJSON data.  Facts, rules, patterns, and
queries are all QJSON arrays and lists.  QJSON's Unbound type
(`?X`) gives pattern variables.  QJSON's `[lo, str, hi]`
projection gives indexed SQL storage.  Horn clauses map directly
to SQL queries.  Resolution is query planning.

## Three levels

| Level | QJSON | Example |
|-------|-------|---------|
| **Goal** | array | `["sibling", "alice", "bob"]` |
| **Clause** (AND) | list of goals | `[head, body1, body2, ...]` |
| **Predicate** (OR) | list of clauses | `[clause1, clause2, ...]` |

### Goal

A QJSON array.  First element is the functor, rest are arguments.
Every element is a QJSON leaf — number, string, BigInt, BigDecimal,
BigFloat, blob, boolean, null, or Unbound (`?X`).

```json
["sibling", "alice", "bob"]
["price", "btc", "67432.50M", "1710000000N"]
["reading", ?From, "temp", ?Val]
[?Rel, 1, 2]
```

The functor can be unbound (`[?Rel, 1, 2]`) — matches any
binary relation where the arguments are 1 and 2.
Meta-predicates for free.

### Clause (AND)

A list of goals.  First goal is the head (what is defined).
Rest is the body (the conditions).

```json
[["uncle", ?X, ?Y], ["parent", ?Z, ?Y], ["sibling", ?X, ?Z]]
```

Reads: `uncle(X, Y) :- parent(Z, Y), sibling(X, Z).`

A fact has just a head, no body:

```json
[["sibling", "alice", "bob"]]
```

### Predicate (OR)

A list of clauses — disjunction.

```json
[
  [["path", ?X, ?Y], ["edge", ?X, ?Y]],
  [["path", ?X, ?Y], ["edge", ?X, ?Z], ["path", ?Z, ?Y]]
]
```

Reads: `path(X,Y) :- edge(X,Y).` OR `path(X,Y) :- edge(X,Z), path(Z,Y).`

## Horn clauses are WHERE clauses

| Prolog | SQL |
|--------|-----|
| clause head | SELECT |
| clause body | WHERE (JOIN across body goals) |
| `,` (conjunction) | AND |
| multiple clauses | OR / UNION ALL |
| shared variable `?X` | JOIN condition (equi-join on column) |
| `?_` (anonymous) | no constraint on that column |
| fact (no body) | row, no WHERE |

## Three tiers of storage

| State | Storage | Resolution |
|-------|---------|------------|
| **Fact** (dynamic) | row in `y8_<functor>_<arity>` table | table lookup |
| **Rule** (dynamic) | QJSON list-of-lists (clause data) | compile JOIN query per resolution |
| **Mineralized** | VIEW or materialized table | table lookup (same as fact) |

### Facts — rows

Most predicates are facts.  Each functor/arity gets a table.
Each argument gets `[lo, str, hi]` columns via QJSON projection.

```sql
CREATE TABLE y8_sibling_2 (
  arg0     TEXT,  arg0_lo REAL, arg0_hi REAL,
  arg1     TEXT,  arg1_lo REAL, arg1_hi REAL
);
```

`["sibling", "alice", "bob"]` →

```sql
INSERT INTO y8_sibling_2 VALUES (
  'alice',  NULL, NULL,
  'bob',    NULL, NULL
);
```

### Rules — compiled per resolution

Rules are stored as QJSON clause data (the list-of-lists).
When the engine resolves a goal against a rule, it compiles
the clause to a SQL JOIN query on the fly:

```
query: ["uncle", "bob", ?Y]

1. Look up y8_uncle_2 table — any matching facts? (indexed scan)
2. Look up uncle/2 rules — compile each clause body to JOIN:

   SELECT S.arg0 AS arg0, P.arg1 AS arg1
   FROM y8_parent_2 P
   JOIN y8_sibling_2 S
     ON qjson_cmp(P.arg0_type, P.arg0_lo, P.arg0, P.arg0_hi,
                  S.arg1_type, S.arg1_lo, S.arg1, S.arg1_hi) = 0
   WHERE S.arg0 = 'bob'

3. Iterate results.
```

No views created.  No catalog bloat.  The query is built,
executed, and discarded.

### Mineralize — freeze to VIEW

`mineralize(uncle/2)` compiles the rule to a persistent VIEW
(or materialized table).  The rule is frozen — its body goals
are baked into the JOIN.  Future lookups are table scans.

```sql
CREATE VIEW y8_uncle_2_v AS
SELECT S.arg0 AS arg0, P.arg1 AS arg1,
       S.arg0_lo, S.arg0_hi, S.arg0,
       P.arg1_lo, P.arg1_hi, P.arg1
FROM y8_parent_2 P
JOIN y8_sibling_2 S
  ON qjson_cmp(...) = 0;
```

Now `["uncle", "bob", ?Y]` resolves via:

```sql
SELECT * FROM y8_uncle_2_v WHERE arg0 = 'bob'
```

Same performance as a fact table.  The rule is gone — replaced
by its compiled form.

**Fossilize** = mineralize everything.  All rules become views.
The engine is a pure query executor: goals in, bindings out.

## Resolution is query planning

| Operation | Prolog | SQL |
|-----------|--------|-----|
| Match goal to fact | unification | indexed WHERE |
| Match goal to rule | compile + resolve body | compile JOIN + execute |
| Shared variables | binding environment | JOIN condition |
| Backtracking | choice points | result set iteration |
| Negation (`\+`) | negation as failure | NOT EXISTS subquery |
| `findall/3` | collect all solutions | full result set |
| Recursive predicate | recursive resolution | WITH RECURSIVE |

The SQL engine handles backtracking (result iteration), index
selection, join ordering, and query optimization.  The Prolog
engine compiles clauses to queries and iterates results.

## Projection: QJSON `[lo, str, hi]`

Every element in a goal projects to three SQL columns via QJSON:

| Value | lo | str | hi |
|-------|----|-----|----|
| `42` (exact double) | 42.0 | NULL | 42.0 |
| `"67432.50M"` | 67432.5 | NULL | 67432.5 |
| `"0.1M"` (inexact) | roundDown(0.1) | `"0.1"` | roundUp(0.1) |
| `"9007199254740993N"` | 2^53 | `"9007199254740993"` | 2^53+2 |
| `"btc"` (string) | NULL | `"btc"` | NULL |
| `?X` (unbound) | -Infinity | `"?X"` | +Infinity |

Unbound projects to `[-Inf, "?name", +Inf]` — passes through
all WHERE clauses.  Shared `?X` across goals becomes a JOIN.

See `vendor/qjson/docs/qjson.md` for `qjson_cmp`, `roundDown`,
`roundUp`, and the full type system.

## Persistence via react rules

```prolog
react(assert(F))  :- native(db_insert(F), _Ok).
react(retract(F)) :- native(db_remove(F), _Ok).
```

| Prolog | SQL |
|--------|-----|
| `assert(F)` | INSERT into per-predicate table |
| `retract(F)` | DELETE matching row |
| `ephemeral(E)` | no SQL — triggers react, never persists |

Ephemeral events flow through react rules but never touch storage.
Fossilized engines can still process ephemeral events — they have
no dynamic facts, only frozen views and incoming signals.
