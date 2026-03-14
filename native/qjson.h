/* ============================================================
 * qjson.h — Native C QJSON parser/serializer
 *
 * Arena-allocated: zero malloc per parse.  Reset between messages.
 *
 *   qj_arena a; qj_arena_init(&a, buf, sizeof(buf));
 *   qj_val *v = qj_parse(&a, text, len);
 *   char out[1024]; int n = qj_stringify(v, out, sizeof(out));
 *   qj_arena_reset(&a);  // ready for next message
 * ============================================================ */

#ifndef QJSON_H
#define QJSON_H

#include <stdint.h>
#include <stddef.h>

typedef enum {
    QJ_NULL, QJ_TRUE, QJ_FALSE,
    QJ_NUM,          /* double */
    QJ_BIGINT,       /* raw string, suffix N */
    QJ_BIGDEC,       /* raw string, suffix M */
    QJ_BIGFLOAT,     /* raw string, suffix L */
    QJ_STRING,
    QJ_ARRAY,
    QJ_OBJECT
} qj_type;

typedef struct qj_val qj_val;

typedef struct {
    const char *key;
    int         key_len;
    qj_val     *val;
} qj_kv;

struct qj_val {
    qj_type type;
    union {
        double  num;
        struct { const char *s; int len; } str;   /* string/bignum raw text */
        struct { qj_val **items; int count; } arr;
        struct { qj_kv  *pairs; int count; } obj;
    };
};

/* ── Arena ───────────────────────────────────────────────── */

typedef struct {
    char   *buf;
    size_t  used;
    size_t  cap;
} qj_arena;

void  qj_arena_init(qj_arena *a, void *buf, size_t cap);
void  qj_arena_reset(qj_arena *a);
void *qj_arena_alloc(qj_arena *a, size_t size);

/* ── Parse ───────────────────────────────────────────────── */

/* Parse QJSON text.  Returns root value or NULL on error.
   All memory from arena — no malloc. */
qj_val *qj_parse(qj_arena *a, const char *text, int len);

/* ── Stringify ───────────────────────────────────────────── */

/* Write QJSON to buffer.  Returns bytes written (excluding NUL).
   BigInt→N, BigDecimal→M, BigFloat→L. */
int qj_stringify(const qj_val *v, char *buf, int cap);

/* ── Accessors ───────────────────────────────────────────── */

static inline qj_type  qj_type_of(const qj_val *v) { return v ? v->type : QJ_NULL; }
static inline double   qj_num(const qj_val *v)     { return v && v->type == QJ_NUM ? v->num : 0; }
static inline const char *qj_str(const qj_val *v)  { return v && v->type == QJ_STRING ? v->str.s : NULL; }
static inline int      qj_str_len(const qj_val *v) { return v && v->type == QJ_STRING ? v->str.len : 0; }
static inline int      qj_arr_len(const qj_val *v) { return v && v->type == QJ_ARRAY ? v->arr.count : 0; }
static inline qj_val  *qj_arr_get(const qj_val *v, int i) {
    return (v && v->type == QJ_ARRAY && i >= 0 && i < v->arr.count) ? v->arr.items[i] : NULL;
}
static inline int      qj_obj_len(const qj_val *v) { return v && v->type == QJ_OBJECT ? v->obj.count : 0; }
qj_val *qj_obj_get(const qj_val *v, const char *key);

#endif
