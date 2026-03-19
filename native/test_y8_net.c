/* ============================================================
 * test_y8_net.c — Stress tests for y8 wire framing + pipe
 *
 * gcc -O2 -Wall -std=c11 -o test_y8_net test_y8_net.c y8_net.c
 *   -lpthread && ./test_y8_net
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/time.h>
#include "y8_net.h"

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s  [line %d]\n", name, __LINE__); } \
} while(0)

/* ── Helper: create socketpair for testing ──────────── */

static void make_pair(int fds[2]) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) < 0) {
        perror("socketpair");
        exit(1);
    }
}

/* ── Basic framing tests ────────────────────────────── */

static void test_basic_framing(void) {
    printf("=== Basic framing ===\n");
    int fds[2];
    make_pair(fds);

    /* Simple message */
    const char *msg = "hello";
    TEST("write succeeds", y8_frame_write(fds[1], msg, 5) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read succeeds", r == 5);
    TEST("read length", len == 5);
    TEST("read content", buf && memcmp(buf, "hello", 5) == 0);
    free(buf);

    /* Keepalive ping */
    TEST("ping write", y8_frame_ping(fds[1]) == 0);
    r = y8_frame_read(fds[0], &buf, &len);
    TEST("ping read returns 0", r == 0);
    TEST("ping data is null", buf == NULL);
    TEST("ping len is 0", len == 0);

    /* Empty message (length 0 = ping) */
    TEST("empty write", y8_frame_write(fds[1], NULL, 0) == 0);
    r = y8_frame_read(fds[0], &buf, &len);
    TEST("empty read = ping", r == 0);

    close(fds[0]); close(fds[1]);
}

/* ── Binary safety: all 256 byte values ─────────────── */

static void test_binary_safety(void) {
    printf("\n=== Binary safety ===\n");
    int fds[2];
    make_pair(fds);

    char blob[256];
    for (int i = 0; i < 256; i++) blob[i] = (char)i;

    TEST("write 256 bytes", y8_frame_write(fds[1], blob, 256) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read 256 bytes", r == 256 && len == 256);

    int match = 1;
    for (int i = 0; i < 256; i++) {
        if ((unsigned char)buf[i] != (unsigned char)i) { match = 0; break; }
    }
    TEST("all 256 byte values preserved", match);
    free(buf);

    close(fds[0]); close(fds[1]);
}

/* ── Multiple messages in sequence ──────────────────── */

static void test_multiple_messages(void) {
    printf("\n=== Multiple messages ===\n");
    int fds[2];
    make_pair(fds);

    int count = 1000;
    for (int i = 0; i < count; i++) {
        char msg[32];
        int n = snprintf(msg, sizeof(msg), "msg-%d", i);
        if (y8_frame_write(fds[1], msg, n) < 0) {
            TEST("write 1000 messages", 0);
            close(fds[0]); close(fds[1]);
            return;
        }
    }

    int ok = 1;
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        int r = y8_frame_read(fds[0], &buf, &len);
        char expected[32];
        int elen = snprintf(expected, sizeof(expected), "msg-%d", i);
        if (r != elen || len != elen || !buf || memcmp(buf, expected, elen) != 0) {
            ok = 0;
        }
        free(buf);
    }
    TEST("1000 messages round-trip", ok);

    close(fds[0]); close(fds[1]);
}

/* ── Thread helpers (used by large message, interleaved, throughput) */

typedef struct {
    int fd;
    int count;
    int ok;
} thread_arg;

static void *sender_thread(void *arg) {
    thread_arg *ta = (thread_arg *)arg;
    ta->ok = 1;
    for (int i = 0; i < ta->count; i++) {
        char msg[32];
        int n = snprintf(msg, sizeof(msg), "s%d", i);
        if (y8_frame_write(ta->fd, msg, n) < 0) { ta->ok = 0; break; }
    }
    return NULL;
}

static void *receiver_thread(void *arg) {
    thread_arg *ta = (thread_arg *)arg;
    ta->ok = 1;
    for (int i = 0; i < ta->count; i++) {
        char *buf = NULL; int len = 0;
        int r = y8_frame_read(ta->fd, &buf, &len);
        if (r < 0) { ta->ok = 0; free(buf); break; }
        free(buf);
    }
    return NULL;
}

/* ── Large message (1 MB) ───────────────────────────── */

static void *large_writer(void *arg) {
    thread_arg *ta = (thread_arg *)arg;
    int size = 1024 * 1024;
    char *big = (char *)malloc(size);
    for (int i = 0; i < size; i++) big[i] = (char)(i & 0xFF);
    ta->ok = (y8_frame_write(ta->fd, big, size) == 0) ? 1 : 0;
    free(big);
    return NULL;
}

static void test_large_message(void) {
    printf("\n=== Large message ===\n");
    int fds[2];
    make_pair(fds);

    int size = 1024 * 1024;
    thread_arg wa = { fds[1], 0, 0 };
    pthread_t wt;
    pthread_create(&wt, NULL, large_writer, &wa);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    pthread_join(wt, NULL);

    TEST("1MB write+read", r == size && len == size);

    int match = 1;
    if (buf) {
        for (int i = 0; i < size; i++) {
            if ((unsigned char)buf[i] != (unsigned char)(i & 0xFF)) {
                match = 0; break;
            }
        }
    } else { match = 0; }
    TEST("1MB content intact", match);

    free(buf);
    close(fds[0]); close(fds[1]);
}

/* ── Pipe transport ─────────────────────────────────── */

static void test_pipe_transport(void) {
    printf("\n=== Pipe transport ===\n");
    int fds[2];
    make_pair(fds);

    y8_pipe a, b;
    y8_pipe_init(&a, fds[0], fds[1]);
    y8_pipe_init(&b, fds[1], fds[0]);

    /* Note: a writes to fds[1], b reads from fds[1] — wrong.
       For bidirectional, need two socketpairs or cross fds. */
    /* Actually socketpair gives full-duplex: both fds can read and write */
    y8_pipe sender, receiver;
    y8_pipe_init(&sender, fds[0], fds[0]);    /* read+write on same fd */
    y8_pipe_init(&receiver, fds[1], fds[1]);

    const char *msg = "{type: signal, value: 42}";
    TEST("pipe send", y8_pipe_send(&sender, msg, (int)strlen(msg)) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_pipe_recv(&receiver, &buf, &len);
    TEST("pipe recv", r == (int)strlen(msg));
    TEST("pipe content", buf && memcmp(buf, msg, strlen(msg)) == 0);
    free(buf);

    /* Reverse direction */
    const char *reply = "{ok: true}";
    TEST("pipe send reverse", y8_pipe_send(&receiver, reply, (int)strlen(reply)) == 0);

    r = y8_pipe_recv(&sender, &buf, &len);
    TEST("pipe recv reverse", r == (int)strlen(reply));
    TEST("pipe content reverse", buf && memcmp(buf, reply, strlen(reply)) == 0);
    free(buf);

    close(fds[0]); close(fds[1]);
}

/* ── EOF detection ──────────────────────────────────── */

static void test_eof_detection(void) {
    printf("\n=== EOF detection ===\n");
    int fds[2];
    make_pair(fds);

    /* Write one message then close writer */
    const char *msg = "last";
    y8_frame_write(fds[1], msg, 4);
    close(fds[1]);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read before EOF", r == 4);
    free(buf);

    r = y8_frame_read(fds[0], &buf, &len);
    TEST("read after close = -1", r == -1);

    close(fds[0]);
}

/* ── Interleaved send/recv (threaded) ───────────────── */

static void test_interleaved(void) {
    printf("\n=== Interleaved send/recv ===\n");
    int fds[2];
    make_pair(fds);

    int count = 1000;
    thread_arg sa = { fds[1], count, 0 };
    thread_arg ra = { fds[0], count, 0 };

    pthread_t st, rt;
    pthread_create(&st, NULL, sender_thread, &sa);
    pthread_create(&rt, NULL, receiver_thread, &ra);
    pthread_join(st, NULL);
    pthread_join(rt, NULL);

    TEST("interleaved send ok", sa.ok);
    TEST("interleaved recv ok", ra.ok);

    close(fds[0]); close(fds[1]);
}

/* ── Throughput benchmark ───────────────────────────── */

static void test_throughput(void) {
    printf("\n=== Throughput benchmark ===\n");
    int fds[2];
    make_pair(fds);

    int count = 1000;
    thread_arg sa = { fds[1], count, 0 };

    pthread_t st;
    pthread_create(&st, NULL, sender_thread, &sa);

    struct timeval t0, t1;
    gettimeofday(&t0, NULL);

    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        y8_frame_read(fds[0], &buf, &len);
        free(buf);
    }

    gettimeofday(&t1, NULL);
    pthread_join(st, NULL);

    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_usec - t0.tv_usec) / 1000.0;
    printf("  %d messages in %.1f ms (%.1f K msg/sec)\n",
           count, ms, count / ms);
    TEST("throughput completes", sa.ok && ms > 0);

    close(fds[0]); close(fds[1]);
}

/* ── Oversized message rejected ─────────────────────── */

static void test_oversize(void) {
    printf("\n=== Oversize rejection ===\n");
    int fds[2];
    make_pair(fds);

    /* Try to write a message larger than Y8_NET_MAX_MSG */
    int big = Y8_NET_MAX_MSG + 1;
    TEST("oversize write rejected", y8_frame_write(fds[1], "x", big) == -1);

    close(fds[0]); close(fds[1]);
}

/* ── Main ────────────────────────────────────────────── */

int main(void) {
    test_basic_framing();
    test_binary_safety();
    test_multiple_messages();
    test_large_message();
    test_pipe_transport();
    test_eof_detection();
    test_interleaved();
    test_throughput();
    test_oversize();

    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
