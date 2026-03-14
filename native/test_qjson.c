/* ============================================================
 * test_qjson.c — Tests + benchmarks for native C QJSON
 *
 * gcc -O2 -o test_qjson qjson.c test_qjson.c && ./test_qjson
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "qjson.h"

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s  [line %d]\n", name, __LINE__); } \
} while(0)

/* ── Correctness tests ───────────────────────────────────── */

static char arena_buf[65536];

static void test_parse_basic(void) {
    printf("=== Parse basics ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));

    qj_val *v = qj_parse(&a, "42", 2);
    TEST("parse integer", v && v->type == QJ_NUM && v->num == 42);

    qj_arena_reset(&a);
    v = qj_parse(&a, "-3.14", 5);
    TEST("parse float", v && v->type == QJ_NUM && v->num < -3.13 && v->num > -3.15);

    qj_arena_reset(&a);
    v = qj_parse(&a, "\"hello\"", 7);
    TEST("parse string", v && v->type == QJ_STRING && strcmp(v->str.s, "hello") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "true", 4);
    TEST("parse true", v && v->type == QJ_TRUE);

    qj_arena_reset(&a);
    v = qj_parse(&a, "false", 5);
    TEST("parse false", v && v->type == QJ_FALSE);

    qj_arena_reset(&a);
    v = qj_parse(&a, "null", 4);
    TEST("parse null", v && v->type == QJ_NULL);
}

static void test_parse_compound(void) {
    printf("\n=== Parse compound ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));

    qj_val *v = qj_parse(&a, "[1,2,3]", 7);
    TEST("parse array", v && v->type == QJ_ARRAY && v->arr.count == 3);
    TEST("array[0]", qj_arr_get(v, 0)->num == 1);
    TEST("array[2]", qj_arr_get(v, 2)->num == 3);

    qj_arena_reset(&a);
    v = qj_parse(&a, "{\"a\":1,\"b\":2}", 13);
    TEST("parse object", v && v->type == QJ_OBJECT && v->obj.count == 2);
    TEST("obj.a", qj_obj_get(v, "a") && qj_obj_get(v, "a")->num == 1);
    TEST("obj.b", qj_obj_get(v, "b") && qj_obj_get(v, "b")->num == 2);
}

static void test_parse_bignum(void) {
    printf("\n=== Parse bignums ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));

    qj_val *v = qj_parse(&a, "42N", 3);
    TEST("BigInt N", v && v->type == QJ_BIGINT && strcmp(v->str.s, "42") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "42n", 3);
    TEST("BigInt n (lc)", v && v->type == QJ_BIGINT);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14M", 5);
    TEST("BigDecimal M", v && v->type == QJ_BIGDEC && strcmp(v->str.s, "3.14") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14m", 5);
    TEST("BigDecimal m (lc)", v && v->type == QJ_BIGDEC);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14L", 5);
    TEST("BigFloat L", v && v->type == QJ_BIGFLOAT && strcmp(v->str.s, "3.14") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14l", 5);
    TEST("BigFloat l (lc)", v && v->type == QJ_BIGFLOAT);
}

static void test_parse_comments(void) {
    printf("\n=== Parse comments ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));

    const char *s = "// line comment\n42";
    qj_val *v = qj_parse(&a, s, strlen(s));
    TEST("line comment", v && v->type == QJ_NUM && v->num == 42);

    qj_arena_reset(&a);
    s = "/* block */ 42";
    v = qj_parse(&a, s, strlen(s));
    TEST("block comment", v && v->type == QJ_NUM && v->num == 42);

    qj_arena_reset(&a);
    s = "/* outer /* inner */ still */ 42";
    v = qj_parse(&a, s, strlen(s));
    TEST("nested block comment", v && v->type == QJ_NUM && v->num == 42);
}

static void test_parse_human(void) {
    printf("\n=== Parse human-friendly ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));

    const char *s = "[1, 2, 3,]";
    qj_val *v = qj_parse(&a, s, strlen(s));
    TEST("trailing comma array", v && v->type == QJ_ARRAY && v->arr.count == 3);

    qj_arena_reset(&a);
    s = "{\"a\": 1, \"b\": 2,}";
    v = qj_parse(&a, s, strlen(s));
    TEST("trailing comma object", v && v->type == QJ_OBJECT && v->obj.count == 2);

    qj_arena_reset(&a);
    s = "{name: \"alice\", age: 30}";
    v = qj_parse(&a, s, strlen(s));
    TEST("unquoted keys", v && v->type == QJ_OBJECT && v->obj.count == 2);
    TEST("unquoted key value", qj_obj_get(v, "name") && strcmp(qj_str(qj_obj_get(v, "name")), "alice") == 0);
}

static void test_stringify(void) {
    printf("\n=== Stringify ===\n");
    qj_arena a; qj_arena_init(&a, arena_buf, sizeof(arena_buf));
    char out[1024];

    /* Round-trip: parse then stringify */
    const char *s = "{\"t\":\"c\",\"f\":\"temp\",\"a\":[{\"t\":\"a\",\"n\":\"kitchen\"},{\"t\":\"n\",\"v\":22}]}";
    qj_val *v = qj_parse(&a, s, strlen(s));
    TEST("parse term json", v != NULL);
    int n = qj_stringify(v, out, sizeof(out));
    TEST("stringify term", n > 0 && strcmp(out, s) == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "42N", 3);
    n = qj_stringify(v, out, sizeof(out));
    TEST("stringify BigInt → N", strcmp(out, "42N") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14M", 5);
    n = qj_stringify(v, out, sizeof(out));
    TEST("stringify BigDec → M", strcmp(out, "3.14M") == 0);

    qj_arena_reset(&a);
    v = qj_parse(&a, "3.14L", 5);
    n = qj_stringify(v, out, sizeof(out));
    TEST("stringify BigFloat → L", strcmp(out, "3.14L") == 0);
}

/* ── Benchmark ───────────────────────────────────────────── */

static void benchmark(void) {
    printf("\n=== Benchmark ===\n");

    /* Typical Prolog term serialization (persist hot path) */
    const char *msg =
        "{\"t\":\"c\",\"f\":\"reading\",\"a\":["
        "{\"t\":\"a\",\"n\":\"sensor_1\"},"
        "{\"t\":\"a\",\"n\":\"temperature\"},"
        "{\"t\":\"n\",\"v\":22},"
        "{\"t\":\"n\",\"v\":1710400000}]}";
    int msg_len = strlen(msg);

    char arena_bench[8192];
    qj_arena a;
    char out[512];
    int iterations = 1000000;

    /* Parse benchmark */
    {
        qj_arena_init(&a, arena_bench, sizeof(arena_bench));
        clock_t start = clock();
        for (int i = 0; i < iterations; i++) {
            qj_arena_reset(&a);
            qj_parse(&a, msg, msg_len);
        }
        clock_t end = clock();
        double ms = (double)(end - start) / CLOCKS_PER_SEC * 1000.0;
        printf("  Parse:     %d messages in %.1f ms (%.1f M msg/sec)\n",
               iterations, ms, iterations / ms / 1000.0);
    }

    /* Stringify benchmark */
    {
        qj_arena_init(&a, arena_bench, sizeof(arena_bench));
        qj_val *v = qj_parse(&a, msg, msg_len);
        clock_t start = clock();
        for (int i = 0; i < iterations; i++) {
            qj_stringify(v, out, sizeof(out));
        }
        clock_t end = clock();
        double ms = (double)(end - start) / CLOCKS_PER_SEC * 1000.0;
        printf("  Stringify: %d messages in %.1f ms (%.1f M msg/sec)\n",
               iterations, ms, iterations / ms / 1000.0);
    }

    /* Memory profile */
    {
        qj_arena_init(&a, arena_bench, sizeof(arena_bench));
        qj_parse(&a, msg, msg_len);
        printf("  Memory:    %zu bytes per parse (%zu byte arena, %d%% used)\n",
               a.used, sizeof(arena_bench), (int)(a.used * 100 / sizeof(arena_bench)));
        printf("  Message:   %d bytes input, %d bytes output\n",
               msg_len, (int)strlen(out));
        printf("  Malloc:    0 per message (arena-allocated)\n");
    }
}

/* ── Main ────────────────────────────────────────────────── */

int main(void) {
    test_parse_basic();
    test_parse_compound();
    test_parse_bignum();
    test_parse_comments();
    test_parse_human();
    test_stringify();
    benchmark();

    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
