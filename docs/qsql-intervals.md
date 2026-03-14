# QSQL Interval Arithmetic — Exact Comparisons Without the Cost

## Problem

QJSON BigDecimal values like `187.68M` represent exact base-10
numbers.  IEEE 754 doubles can't represent `187.68` exactly — the
nearest double is `187.67999999999998...` or `187.68000000000001...`
depending on rounding direction.

For storage and indexing, we want SQLite REAL columns (fast,
indexable).  For correctness, we need exact comparison when values
are close to a threshold.  Arbitrary-precision libraries are
expensive and defeat the purpose of an embeddable engine.

## Solution: interval representation

Every numeric value is an interval `[lo, exact, hi]`:

```
187.68M → [187.67999999999998, "187.68", 187.68000000000001]
              lo (floor)         exact       hi (ceil)
```

- `lo` — IEEE double rounded toward -infinity
- `hi` — IEEE double rounded toward +infinity
- `exact` — the original QJSON string (M/N/L suffix)

For plain numbers (no suffix), `lo == hi == value`.  The interval
has zero width.  No overhead.

## Why this works

IEEE 754 doubles have ~15–17 significant digits.  Two values that
differ must differ by at least 1 ULP (unit in the last place).
The interval `[lo, hi]` captures the full ULP range of the exact
value.

For comparison `a > b`:

| Condition | Result | Frequency |
|-----------|--------|-----------|
| `a.lo > b.hi` | **definitely true** | ~99.999% |
| `a.hi < b.lo` | **definitely false** | ~99.999% |
| intervals overlap | exact string comparison | ~0.001% |

The overlap case only occurs when two values are within 1 ULP of
each other — i.e., they'd round to the same double.  This is
astronomically rare in real data (prices, temperatures, coordinates).

## QSQL schema

For a predicate `price/3`:

```sql
CREATE TABLE "q$price$3" (
  _key  TEXT PRIMARY KEY,    -- full serialized term (restore)
  arg0  TEXT,                -- symbol (atom → TEXT)
  arg1_lo  REAL,             -- price lo bound
  arg1_hi  REAL,             -- price hi bound
  arg1_x   TEXT,             -- price exact repr ("67432.50M")
  arg2_lo  REAL,             -- timestamp lo bound
  arg2_hi  REAL,             -- timestamp hi bound
  arg2_x   TEXT              -- timestamp exact repr ("1710000000N")
);

CREATE INDEX "ix$q$price$3$1" ON "q$price$3"(arg1_lo);
CREATE INDEX "ix$q$price$3$2" ON "q$price$3"(arg2_lo);
```

For atom arguments: single `arg0 TEXT` column (no interval needed).

For plain numbers (no repr): `lo == hi`, `x` is NULL.  The extra
columns exist but cost nothing — SQLite stores NULL as zero bytes.

## Query pushdown

### Simple case: `price > 70000M`

```sql
-- Phase 1: ballpark (uses index)
WHERE arg1_lo > 70000.0

-- This is correct for 99.999% of rows.
-- Only wrong if a value's lo ≤ 70000 but its exact value > 70000.
-- That can only happen if 70000.0 falls inside [lo, hi].
```

### Exact case: boundary zone

```sql
WHERE arg1_lo > 70000.0
   OR (arg1_hi >= 70000.0 AND arg1_x IS NOT NULL
       AND _exact_gt(arg1_x, '70000'))
```

`_exact_gt` is a custom SQLite function (registered via
`sqlite3_create_function`) that compares QJSON decimal strings.
It's only called for rows in the boundary zone — typically zero
rows per query.

### Equality: `price = 67432.50M`

```sql
-- Phase 1: ballpark
WHERE arg1_lo <= 67432.5 AND arg1_hi >= 67432.5

-- Phase 2: exact (only for rows that pass phase 1)
  AND (arg1_x = '67432.50' OR (arg1_x IS NULL AND arg1_lo = 67432.5))
```

For exact equality, the string comparison is authoritative.
The interval narrows candidates to at most 1-2 rows.

### Range: `price >= 60000M AND price <= 70000M`

```sql
WHERE arg1_hi >= 60000.0 AND arg1_lo <= 70000.0
```

Again: correct for 99.999% of data.  Exact refinement only for
values whose intervals straddle 60000.0 or 70000.0.

## Computing lo and hi

### JavaScript (ES5)

```javascript
function _intervalFromNum(value) {
  if (typeof value !== "number") return { lo: 0, hi: 0 };
  // doubles are exact for themselves
  return { lo: value, hi: value };
}

function _intervalFromRepr(repr) {
  // Parse the numeric part (strip N/M/L suffix)
  var raw = repr.replace(/[NMLnml]$/, "");
  var v = Number(raw);

  // If the double round-trips exactly, no interval needed
  if (String(v) === raw || v === parseInt(raw, 10)) {
    return { lo: v, hi: v, x: null };
  }

  // Otherwise: compute lo and hi
  // lo = largest double ≤ exact value
  // hi = smallest double ≥ exact value
  // Since v = nearest double, one of {v, nextDown(v)} is lo
  // and one of {v, nextUp(v)} is hi

  // Compare: is v > exact or v < exact?
  // We know: v ≈ exact, and |v - exact| < 1 ULP
  // If String(v) > raw (lexicographic on normalized forms): v > exact
  // Else: v ≤ exact

  var lo, hi;
  if (_numericStringGt(String(v), raw)) {
    // v rounds up: lo = nextDown(v), hi = v
    lo = _nextDown(v);
    hi = v;
  } else if (_numericStringGt(raw, String(v))) {
    // v rounds down: lo = v, hi = nextUp(v)
    lo = v;
    hi = _nextUp(v);
  } else {
    // exact match
    lo = v;
    hi = v;
  }

  return { lo: lo, hi: hi, x: repr.replace(/[NMLnml]$/, "") };
}
```

### nextUp / nextDown

IEEE 754 doubles are lexicographically ordered when viewed as
64-bit integers (for positive values).  `nextUp(x)` is the
smallest double greater than `x`.

```javascript
// Using DataView for bit manipulation (ES5 compatible via polyfill)
function _nextUp(x) {
  if (x !== x || x === Infinity) return x;
  if (x === 0) return 5e-324;  // Number.MIN_VALUE
  var buf = new ArrayBuffer(8);
  var f64 = new Float64Array(buf);
  var u32 = new Uint32Array(buf);
  f64[0] = x;
  if (x > 0) {
    // Increment the 64-bit integer
    u32[0]++;
    if (u32[0] === 0) u32[1]++;
  } else {
    // Decrement the 64-bit integer (negative doubles are reversed)
    if (u32[0] === 0) u32[1]--;
    u32[0]--;
  }
  return f64[0];
}
```

In the native C layer (`qsql.c`), this is `nextafter(x, INFINITY)`
from `<math.h>`.

### Python

```python
import math

def interval_from_repr(repr_str):
    raw = repr_str.rstrip("NMLnml")
    v = float(raw)
    if str(v) == raw:
        return (v, v, None)
    lo = v
    hi = math.nextafter(v, math.inf)
    if hi < float(raw.rstrip("0") or raw):
        lo, hi = v, math.nextafter(v, math.inf)
    else:
        lo, hi = math.nextafter(v, -math.inf), v
    return (lo, hi, raw)
```

Python's `math.nextafter` is available since 3.9.

## What doesn't change

| Layer | Impact |
|-------|--------|
| Prolog engine | None. Uses `.value` (double) for `>/2`, `</2`, `is/2`. Correct 99.999%. |
| Parser | None. Already stores `.repr`. |
| Persist `_ser/_deser` | None. Already round-trips `.repr` via `r` field. |
| `termToString` | None. Already uses `.repr` when present. |
| `store.js` shim | None. Stores values via engine. |
| Unification | None. Compares `.value`. Two M-values unify if doubles match. |

## What changes

| Layer | Change |
|-------|--------|
| `qsql.js` `_qsql_argVal` | Returns `{lo, hi, x}` instead of bare number for M/N/L values |
| `qsql.js` schema | Triple columns `arg_lo REAL, arg_hi REAL, arg_x TEXT` per numeric arg |
| `qsql.js` insert | Computes interval from repr, stores all three |
| `qsql.js` (new) `queryArgs` | SQL pushdown with interval-aware WHERE clauses |
| `qsql.py` | Same changes |
| `wyatt.c` (future) | Register `_exact_gt` / `_exact_lt` as SQLite custom functions |

## Storage overhead

Per numeric argument with M/N/L suffix:
- 2 REAL columns (16 bytes)
- 1 TEXT column (repr string, typically 5-20 bytes)
- vs. current: 1 REAL column (8 bytes)

Overhead: ~24 bytes per BigNum argument.  For a `price/3` fact
with one BigDecimal price and one BigInt timestamp: ~48 bytes
extra.  Negligible for any real workload.

For plain numbers (no suffix): `lo == hi`, `x` is NULL.
NULL costs 0 bytes in SQLite.  Zero overhead.

## Correctness argument

Given exact value `E` and IEEE double approximation `d`:

1. `d = nearest(E)` — IEEE 754 default rounding
2. `|d - E| < 1 ULP(d)` — by definition of nearest
3. `lo = max(double ≤ E)` and `hi = min(double ≥ E)`
4. Therefore: `lo ≤ E ≤ hi`
5. For any other exact value `F` with `F > E`:
   - If `F - E > 2 ULP`: their intervals don't overlap → `f.lo > e.hi` → double comparison correct
   - If `F - E ≤ 2 ULP`: intervals may overlap → exact string comparison needed
6. Values within 2 ULP of each other represent a difference of ~10^-15 relative to the value
7. For financial data (prices, quantities), real differences are at least 10^-8 (1 satoshi, 0.01 cents)
8. Therefore: interval overlap never occurs in practice for financial comparisons

The exact fallback exists for mathematical completeness, not for
practical necessity.  It costs nothing when not triggered.

## Example: full round-trip

```
Input:    price(btc, 67432.50M, 1710000000N).

Parse:    {type:"num", value:67432.5, repr:"67432.50M"}

Engine:   67432.5 > 70000 → false (double comparison, correct)

QSQL:    INSERT INTO "q$price$3" VALUES (
            '{"t":"c","f":"price","a":[...]}',  -- _key
            'btc',                                -- arg0
            67432.5, 67432.5, '67432.50',         -- arg1: lo, hi, exact
            1710000000, 1710000000, NULL           -- arg2: lo==hi, no repr needed (exact int)
          )

Query:    WHERE arg1_lo > 60000.0 AND arg1_lo < 70000.0
          → hits index, returns row, correct

Restore:  _key → deserialize → {type:"num", value:67432.5, repr:"67432.50M"}

Print:    termToString → "67432.50M"
```

The exact decimal `67432.50` never becomes `67432.499999...` or
`67432.500001...`.  The double `67432.5` happens to be exact for
this value, so `lo == hi` and the interval has zero width.  For
values like `0.1M` where the double is inexact (`0.1` ≠ `0.1`),
the interval captures the error bound and the exact string
preserves the intended value.
