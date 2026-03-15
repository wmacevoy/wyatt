# QJSON — JSON + exact numerics + binary blobs + comments

QJSON is a superset of JSON.  Every valid JSON document is valid
QJSON.  The extensions add what JSON lacks for configuration,
financial data, and embedded systems: exact numbers, binary data,
and human-friendly syntax.

## Types

| Type | JSON | QJSON extension | Example |
|------|------|-----------------|---------|
| null | `null` | — | `null` |
| boolean | `true`, `false` | — | `true` |
| number | `3.14` | — | `3.14` |
| string | `"hello"` | — | `"hello"` |
| array | `[1, 2]` | trailing comma | `[1, 2,]` |
| object | `{"a": 1}` | unquoted keys, trailing comma | `{a: 1,}` |
| BigInt | — | `N` suffix | `42N` |
| BigDecimal | — | `M` suffix | `67432.50M` |
| BigFloat | — | `L` suffix | `3.14159265358979L` |
| blob | — | `0j` prefix (JS64) | `0jSGVsbG8` |

## Numbers

Plain numbers are IEEE 754 doubles.  Exact when representable
(integers up to 2^53, binary fractions like 0.5).  Inexact
otherwise (0.1, most decimals).

### Suffixed numbers: N, M, L

A suffix after a numeric literal marks it as exact:

```
42N                  // BigInt — arbitrary precision integer
67432.50M            // BigDecimal — exact base-10 decimal
3.14159265358979L    // BigFloat — arbitrary precision float
```

Lowercase accepted, canonicalized to uppercase on output.
The suffix must not be followed by an alphanumeric character
(`42N` is BigInt, `42Name` is a parse error).

**Storage:** The raw decimal string is preserved through the
full round-trip: parse → engine → persist → restore → print.
No precision loss.

**Interval projection:** For database storage, each suffixed
number projects to `[lo, str, hi]`:

- `lo` = largest IEEE double ≤ exact value (REAL, indexed)
- `str` = exact string representation (TEXT, authoritative)
- `hi` = smallest IEEE double ≥ exact value (REAL, indexed)

`lo` and `hi` make search efficient — indexed REAL columns
handle 99.999% of comparisons.  `str` is the authority for
the ~0.001% boundary zone where intervals overlap.
Exact doubles get point intervals (`lo == hi`).  See
`docs/qsql-intervals.md` for the full model.

## Blobs: `0j` prefix

Binary data encoded with JS64 — a base-64 encoding that uses
the 64 legal JavaScript identifier characters as its alphabet.

```
0jSGVsbG8          // 5 bytes: "Hello"
0j0012f580deb4     // raw binary (SHA-256 fragment, key material, etc.)
```

### JS64 alphabet

```
$0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz
```

64 characters: `$`, `0-9`, `A-Z`, `_`, `a-z`.  Sorted by
ASCII code point.  Each character encodes 6 bits.

### Encoding

JS64 packs bits LSB-first into 6-bit chunks mapped to the
alphabet.  The full JS64 encoding produces a leading `$`
(zero bits).  The `0j` prefix replaces this leading `$`:

| Full JS64 | QJSON literal |
|-----------|---------------|
| `$SGVsbG8` | `0jSGVsbG8` |
| `$AAAA` | `0jAAAA` |

To decode a `0j` literal: prepend `$`, then JS64-decode.
To encode a blob for QJSON: JS64-encode, strip leading `$`,
prepend `0j`.

### Why not base64?

Standard base64 uses `+` and `/` which aren't valid in
identifiers or URLs without escaping.  JS64 uses only
identifier-safe characters.  A JS64 blob is a valid token
in JavaScript, Prolog, SQL, and shell without quoting.

### Why `0j`?

Follows the `0b`/`0o`/`0x` convention for literal prefixes.
`j` for JS64.  Case-insensitive (`0j` = `0J`).  Doesn't
conflict with `${}` template interpolation.

## Comments

```
// line comment (to end of line)

/* block comment */

/* nested /* block */ comments */
```

Block comments nest.  This is intentional — you can comment
out a region that already contains comments.

## Trailing commas

```
[1, 2, 3,]          // OK
{a: 1, b: 2,}       // OK
```

## Unquoted keys

Object keys that are valid identifiers don't need quotes:

```
{
    name: "alice",
    age: 30,
    _internal: true,
}
```

Valid unquoted key: starts with `[a-zA-Z_$]`, followed by
`[a-zA-Z0-9_$]`.

## QJSON type enum (C API)

```c
typedef enum {
    Y8_NULL, Y8_TRUE, Y8_FALSE,
    Y8_NUM,          // IEEE 754 double
    Y8_BIGINT,       // raw string, suffix N
    Y8_BIGDEC,       // raw string, suffix M
    Y8_BIGFLOAT,     // raw string, suffix L
    Y8_BLOB,         // JS64-decoded byte array
    Y8_STRING,
    Y8_ARRAY,
    Y8_OBJECT
} y8_type;
```

## Implementations

| Language | File | Notes |
|----------|------|-------|
| C | `native/y8_qjson.h`, `native/y8_qjson.c` | Canonical. Arena-allocated, zero malloc, 3.5M msg/sec. |
| JavaScript | `src/qjson.js` | ES5-compatible. Node, Bun, Deno, QuickJS, Duktape. |
| Python | `src/qjson.py` | Pure Python 3. |

All three implementations parse and stringify the same format.
The C implementation is the reference.

## Grammar (informal)

```
value     = null | true | false | number | bignum | blob
          | string | array | object

number    = JSON number (no suffix)
bignum    = number ("N" | "M" | "L")       // case-insensitive
blob      = "0" ("j" | "J") js64-chars+

string    = '"' chars '"'
array     = '[' (value (',' value)* ','?)? ']'
object    = '{' (pair (',' pair)* ','?)? '}'
pair      = (string | ident) ':' value
ident     = [a-zA-Z_$] [a-zA-Z0-9_$]*

js64-chars = [$0-9A-Z_a-z]+

comment   = '//' to-eol | '/*' (comment | any)* '*/'
ws        = spaces, tabs, newlines, comments
```
