/* ============================================================
 * y8_net.c — QJSON wire framing + pipe transport
 *
 * Zero dependencies: POSIX only (read/write/close).
 * ============================================================ */

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include "y8_net.h"

/* ── Helpers: full read/write with retry on EINTR ──── */

static int write_all(int fd, const char *buf, int len) {
    int written = 0;
    while (written < len) {
        int n = (int)write(fd, buf + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        written += n;
    }
    return 0;
}

static int read_all(int fd, char *buf, int len) {
    int got = 0;
    while (got < len) {
        int n = (int)read(fd, buf + got, len - got);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;  /* EOF */
        got += n;
    }
    return 0;
}

/* ── Frame encoding ────────────────────────────────── */

static void encode_u32be(char *buf, uint32_t val) {
    buf[0] = (char)((val >> 24) & 0xFF);
    buf[1] = (char)((val >> 16) & 0xFF);
    buf[2] = (char)((val >> 8)  & 0xFF);
    buf[3] = (char)((val)       & 0xFF);
}

static uint32_t decode_u32be(const char *buf) {
    return ((uint32_t)(unsigned char)buf[0] << 24)
         | ((uint32_t)(unsigned char)buf[1] << 16)
         | ((uint32_t)(unsigned char)buf[2] << 8)
         | ((uint32_t)(unsigned char)buf[3]);
}

/* ── Framing API ───────────────────────────────────── */

int y8_frame_write(int fd, const char *data, int len) {
    if (len < 0 || len > Y8_NET_MAX_MSG) return -1;
    char hdr[4];
    encode_u32be(hdr, (uint32_t)len);
    if (write_all(fd, hdr, 4) < 0) return -1;
    if (len > 0 && write_all(fd, data, len) < 0) return -1;
    return 0;
}

int y8_frame_read(int fd, char **data, int *len) {
    char hdr[4];
    if (read_all(fd, hdr, 4) < 0) return -1;
    uint32_t size = decode_u32be(hdr);
    if (size == 0) {
        /* Keepalive ping */
        *data = NULL;
        *len = 0;
        return 0;
    }
    if (size > Y8_NET_MAX_MSG) return -1;
    char *buf = (char *)malloc(size);
    if (!buf) return -1;
    if (read_all(fd, buf, (int)size) < 0) {
        free(buf);
        return -1;
    }
    *data = buf;
    *len = (int)size;
    return (int)size;
}

int y8_frame_ping(int fd) {
    char hdr[4] = {0, 0, 0, 0};
    return write_all(fd, hdr, 4);
}

/* ── Pipe transport ────────────────────────────────── */

void y8_pipe_init(y8_pipe *p, int read_fd, int write_fd) {
    p->read_fd = read_fd;
    p->write_fd = write_fd;
}

int y8_pipe_send(y8_pipe *p, const char *data, int len) {
    return y8_frame_write(p->write_fd, data, len);
}

int y8_pipe_recv(y8_pipe *p, char **data, int *len) {
    return y8_frame_read(p->read_fd, data, len);
}

void y8_pipe_close(y8_pipe *p) {
    if (p->read_fd >= 0) { close(p->read_fd); p->read_fd = -1; }
    if (p->write_fd >= 0 && p->write_fd != p->read_fd) {
        close(p->write_fd); p->write_fd = -1;
    }
}
