/* ============================================================
 * y8_net.c — QJSON wire framing + pipe + TCP + UDP + TLS
 *
 * POSIX + optional LibreSSL/OpenSSL for TLS.
 * Compile with -lssl -lcrypto for TLS support.
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#ifdef __has_include
#if __has_include(<openssl/ssl.h>)
#define Y8_HAS_TLS 1
#endif
#endif

#ifdef Y8_HAS_TLS
#include <openssl/ssl.h>
#include <openssl/err.h>
struct y8_tls_ctx { SSL_CTX *ctx; };
#endif
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

/* ── TCP transport ─────────────────────────────────── */

int y8_tcp_listen(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    if (listen(fd, 16) < 0) {
        close(fd); return -1;
    }
    return fd;
}

int y8_tcp_accept(int server_fd) {
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    return accept(server_fd, (struct sockaddr *)&addr, &len);
}

int y8_tcp_connect(const char *host, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) <= 0) {
        close(fd); return -1;
    }

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    return fd;
}

/* ── TCP with auto-reconnect ───────────────────────── */

static void _y8_sleep_ms(int ms) {
    struct timeval tv;
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    select(0, NULL, NULL, NULL, &tv);
}

static void _y8_ssl_close(y8_tcp_conn *c) {
#ifdef Y8_HAS_TLS
    if (c->ssl) { SSL_shutdown((SSL *)c->ssl); SSL_free((SSL *)c->ssl); c->ssl = NULL; }
#endif
}

static int _y8_ssl_connect(y8_tcp_conn *c) {
#ifdef Y8_HAS_TLS
    if (c->tls && c->fd >= 0) {
        SSL *ssl = SSL_new(((y8_tls_ctx *)c->tls)->ctx);
        SSL_set_fd(ssl, c->fd);
        if (SSL_connect(ssl) <= 0) {
            ERR_print_errors_fp(stderr);
            SSL_free(ssl); return -1;
        }
        c->ssl = ssl;
    }
#endif
    return 0;
}

static int _y8_tcp_reconnect(y8_tcp_conn *c) {
    _y8_ssl_close(c);
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
    while (1) {
        int delay = 1 << (c->tries < 12 ? c->tries : 12);
        if (delay > Y8_RECONNECT_MAX_MS) delay = Y8_RECONNECT_MAX_MS;
        _y8_sleep_ms(delay);
        c->fd = y8_tcp_connect(c->host, c->port);
        if (c->fd >= 0 && _y8_ssl_connect(c) == 0) { c->tries = 0; return 0; }
        if (c->fd >= 0) { close(c->fd); c->fd = -1; }
        if (c->tries < 12) c->tries++;
    }
}

void y8_tcp_conn_init(y8_tcp_conn *c, const char *host, int port,
                      y8_tls_ctx *tls)
{
    c->fd = -1;
    c->port = port;
    c->tries = 0;
    c->tls = tls;
    c->ssl = NULL;
    snprintf(c->host, sizeof(c->host), "%s", host);
    c->fd = y8_tcp_connect(host, port);
    if (c->fd >= 0) _y8_ssl_connect(c);
}

static int _y8_tcp_alive(int fd) {
    int err = 0;
    socklen_t elen = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen) < 0) return 0;
    if (err != 0) return 0;
    /* Also try a non-blocking peek to detect RST */
    char tmp;
    int n = (int)recv(fd, &tmp, 1, MSG_PEEK | MSG_DONTWAIT);
    if (n == 0) return 0; /* EOF = peer closed */
    /* n < 0 with EAGAIN/EWOULDBLOCK = still alive, no data */
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) return 0;
    return 1;
}

static int _y8_conn_write(y8_tcp_conn *c, const char *data, int len) {
#ifdef Y8_HAS_TLS
    if (c->ssl) return y8_frame_write_ssl(c->ssl, data, len);
#endif
    return y8_frame_write(c->fd, data, len);
}

static int _y8_conn_read(y8_tcp_conn *c, char **data, int *len) {
#ifdef Y8_HAS_TLS
    if (c->ssl) return y8_frame_read_ssl(c->ssl, data, len);
#endif
    return y8_frame_read(c->fd, data, len);
}

int y8_tcp_conn_send(y8_tcp_conn *c, const char *data, int len) {
    if (c->fd < 0 || !_y8_tcp_alive(c->fd)) _y8_tcp_reconnect(c);
    int r = _y8_conn_write(c, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = _y8_conn_write(c, data, len);
    }
    return r;
}

int y8_tcp_conn_recv(y8_tcp_conn *c, char **data, int *len) {
    if (c->fd < 0) _y8_tcp_reconnect(c);
    int r = _y8_conn_read(c, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = _y8_conn_read(c, data, len);
    }
    return r;
}

void y8_tcp_conn_close(y8_tcp_conn *c) {
    _y8_ssl_close(c);
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
}

/* ── TLS context + SSL framing ─────────────────────── */

#ifdef Y8_HAS_TLS

static int _tls_inited = 0;
static void _tls_init(void) {
    if (!_tls_inited) {
        OPENSSL_init_ssl(0, NULL);
        _tls_inited = 1;
    }
}

y8_tls_ctx *y8_tls_server(const char *cert_file, const char *key_file) {
    _tls_init();
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) return NULL;
    if (SSL_CTX_use_certificate_file(ctx, cert_file, SSL_FILETYPE_PEM) <= 0 ||
        SSL_CTX_use_PrivateKey_file(ctx, key_file, SSL_FILETYPE_PEM) <= 0) {
        SSL_CTX_free(ctx); return NULL;
    }
    y8_tls_ctx *t = (y8_tls_ctx *)malloc(sizeof(*t));
    t->ctx = ctx;
    return t;
}

y8_tls_ctx *y8_tls_client(const char *ca_file) {
    _tls_init();
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) return NULL;
    if (ca_file) {
        SSL_CTX_load_verify_locations(ctx, ca_file, NULL);
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    } else {
        SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
    }
    y8_tls_ctx *t = (y8_tls_ctx *)malloc(sizeof(*t));
    t->ctx = ctx;
    return t;
}

void y8_tls_free(y8_tls_ctx *t) {
    if (t) { SSL_CTX_free(t->ctx); free(t); }
}

void *y8_tls_ssl_new(y8_tls_ctx *ctx, int fd) {
    if (!ctx) return NULL;
    SSL *ssl = SSL_new(ctx->ctx);
    SSL_set_fd(ssl, fd);
    return ssl;
}

int y8_tcp_accept_tls(int server_fd, y8_tls_ctx *tls, void **ssl_out) {
    int fd = y8_tcp_accept(server_fd);
    if (fd < 0) { fprintf(stderr, "tcp accept failed: %s\n", strerror(errno)); return -1; }
    if (tls) {
        SSL *ssl = SSL_new(tls->ctx);
        SSL_set_fd(ssl, fd);
        int ar = SSL_accept(ssl);
        if (ar <= 0) {
            fprintf(stderr, "SSL_accept=%d err=%d\n", ar, SSL_get_error(ssl, ar));
            ERR_print_errors_fp(stderr);
            SSL_free(ssl); close(fd); return -1;
        }
        *ssl_out = ssl;
    } else {
        *ssl_out = NULL;
    }
    return fd;
}

static int ssl_write_all(SSL *ssl, const char *buf, int len) {
    int written = 0;
    while (written < len) {
        int n = SSL_write(ssl, buf + written, len - written);
        if (n <= 0) return -1;
        written += n;
    }
    return 0;
}

static int ssl_read_all(SSL *ssl, char *buf, int len) {
    int got = 0;
    while (got < len) {
        int n = SSL_read(ssl, buf + got, len - got);
        if (n <= 0) return -1;
        got += n;
    }
    return 0;
}

int y8_frame_write_ssl(void *ssl, const char *data, int len) {
    if (len < 0 || len > Y8_NET_MAX_MSG) return -1;
    char hdr[4];
    hdr[0] = (char)((len >> 24) & 0xFF);
    hdr[1] = (char)((len >> 16) & 0xFF);
    hdr[2] = (char)((len >> 8)  & 0xFF);
    hdr[3] = (char)((len)       & 0xFF);
    if (ssl_write_all((SSL *)ssl, hdr, 4) < 0) return -1;
    if (len > 0 && ssl_write_all((SSL *)ssl, data, len) < 0) return -1;
    return 0;
}

int y8_frame_read_ssl(void *ssl, char **data, int *len) {
    char hdr[4];
    if (ssl_read_all((SSL *)ssl, hdr, 4) < 0) return -1;
    uint32_t size = ((uint32_t)(unsigned char)hdr[0] << 24)
                  | ((uint32_t)(unsigned char)hdr[1] << 16)
                  | ((uint32_t)(unsigned char)hdr[2] << 8)
                  | ((uint32_t)(unsigned char)hdr[3]);
    if (size == 0) { *data = NULL; *len = 0; return 0; }
    if (size > Y8_NET_MAX_MSG) return -1;
    char *buf = (char *)malloc(size);
    if (!buf) return -1;
    if (ssl_read_all((SSL *)ssl, buf, (int)size) < 0) { free(buf); return -1; }
    *data = buf;
    *len = (int)size;
    return (int)size;
}

#else /* no TLS */

y8_tls_ctx *y8_tls_server(const char *c, const char *k) { (void)c;(void)k; return NULL; }
y8_tls_ctx *y8_tls_client(const char *c) { (void)c; return NULL; }
void y8_tls_free(y8_tls_ctx *t) { (void)t; }
void *y8_tls_ssl_new(y8_tls_ctx *c, int f) { (void)c;(void)f; return NULL; }
int y8_tcp_accept_tls(int s, y8_tls_ctx *t, void **o) { *o=NULL; (void)t; return y8_tcp_accept(s); }
int y8_frame_write_ssl(void *s, const char *d, int l) { (void)s;(void)d;(void)l; return -1; }
int y8_frame_read_ssl(void *s, char **d, int *l) { (void)s;(void)d;(void)l; return -1; }

#endif

/* ── UDP transport ─────────────────────────────────── */

int y8_udp_open(int port) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port); /* 0 = kernel picks */

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    return fd;
}

int y8_udp_send(int fd, const char *host, int port,
                const char *data, int len)
{
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host, &addr.sin_addr);

    ssize_t n = sendto(fd, data, len, 0,
                       (struct sockaddr *)&addr, sizeof(addr));
    return n == len ? 0 : -1;
}

int y8_udp_recv(int fd, char **data, int *len) {
    char buf[65536];
    ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, NULL, NULL);
    if (n < 0) return -1;

    *data = (char *)malloc(n);
    if (!*data) return -1;
    memcpy(*data, buf, n);
    *len = (int)n;
    return (int)n;
}

/* ── WebSocket transport ───────────────────────────── */

/* Minimal SHA-1 for WebSocket accept key (RFC 6455) */
static void _sha1(const unsigned char *msg, int len, unsigned char out[20]) {
    uint32_t h0=0x67452301, h1=0xEFCDAB89, h2=0x98BADCFE, h3=0x10325476, h4=0xC3D2E1F0;
    int ml = len * 8;
    int padded = ((len + 9 + 63) / 64) * 64;
    unsigned char *buf = (unsigned char *)calloc(1, padded);
    memcpy(buf, msg, len);
    buf[len] = 0x80;
    buf[padded-4] = (ml >> 24) & 0xFF;
    buf[padded-3] = (ml >> 16) & 0xFF;
    buf[padded-2] = (ml >> 8) & 0xFF;
    buf[padded-1] = ml & 0xFF;
    for (int c = 0; c < padded; c += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++)
            w[i] = ((uint32_t)buf[c+i*4]<<24)|((uint32_t)buf[c+i*4+1]<<16)|
                    ((uint32_t)buf[c+i*4+2]<<8)|buf[c+i*4+3];
        for (int i = 16; i < 80; i++) {
            uint32_t t = w[i-3]^w[i-8]^w[i-14]^w[i-16];
            w[i] = (t<<1)|(t>>31);
        }
        uint32_t a=h0,b=h1,c2=h2,d=h3,e=h4;
        for (int i = 0; i < 80; i++) {
            uint32_t f,k;
            if (i<20) { f=(b&c2)|((~b)&d); k=0x5A827999; }
            else if (i<40) { f=b^c2^d; k=0x6ED9EBA1; }
            else if (i<60) { f=(b&c2)|(b&d)|(c2&d); k=0x8F1BBCDC; }
            else { f=b^c2^d; k=0xCA62C1D6; }
            uint32_t tmp = ((a<<5)|(a>>27))+f+e+k+w[i];
            e=d; d=c2; c2=(b<<30)|(b>>2); b=a; a=tmp;
        }
        h0+=a; h1+=b; h2+=c2; h3+=d; h4+=e;
    }
    free(buf);
    for (int i=0;i<4;i++) { out[i]=h0>>(24-i*8); out[4+i]=h1>>(24-i*8);
        out[8+i]=h2>>(24-i*8); out[12+i]=h3>>(24-i*8); out[16+i]=h4>>(24-i*8); }
}

static const char _b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static int _b64_encode(const unsigned char *in, int len, char *out) {
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i+1 < len) v |= (uint32_t)in[i+1] << 8;
        if (i+2 < len) v |= in[i+2];
        out[o++] = _b64[(v>>18)&63];
        out[o++] = _b64[(v>>12)&63];
        out[o++] = (i+1 < len) ? _b64[(v>>6)&63] : '=';
        out[o++] = (i+2 < len) ? _b64[v&63] : '=';
    }
    out[o] = '\0';
    return o;
}

/* Read one line from fd (up to maxlen). Returns length or -1. */
static int _read_line(int fd, char *buf, int maxlen) {
    int i = 0;
    while (i < maxlen - 1) {
        char c;
        int n = (int)read(fd, &c, 1);
        if (n <= 0) return -1;
        buf[i++] = c;
        if (c == '\n') break;
    }
    buf[i] = '\0';
    return i;
}

static const char *WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

int y8_ws_accept(y8_ws *ws, int tcp_fd) {
    ws->fd = tcp_fd;
    ws->is_server = 1;

    /* Read HTTP upgrade request, find Sec-WebSocket-Key */
    char key[128] = {0};
    char line[512];
    while (_read_line(tcp_fd, line, sizeof(line)) > 0) {
        if (line[0] == '\r' || line[0] == '\n') break;
        if (strncmp(line, "Sec-WebSocket-Key:", 18) == 0) {
            char *p = line + 18;
            while (*p == ' ') p++;
            int kl = 0;
            while (p[kl] && p[kl] != '\r' && p[kl] != '\n') kl++;
            memcpy(key, p, kl);
            key[kl] = '\0';
        }
    }
    if (!key[0]) return -1;

    /* Compute accept: SHA1(key + magic), base64 */
    char concat[256];
    snprintf(concat, sizeof(concat), "%s%s", key, WS_MAGIC);
    unsigned char hash[20];
    _sha1((unsigned char *)concat, (int)strlen(concat), hash);
    char accept[64];
    _b64_encode(hash, 20, accept);

    /* Send upgrade response */
    char resp[512];
    int rlen = snprintf(resp, sizeof(resp),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n", accept);
    return write_all(tcp_fd, resp, rlen);
}

int y8_ws_connect(y8_ws *ws, const char *host, int port, const char *path) {
    ws->is_server = 0;
    ws->fd = y8_tcp_connect(host, port);
    if (ws->fd < 0) return -1;

    /* Send upgrade request with fixed key (test-friendly) */
    char req[512];
    int rlen = snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n",
        path ? path : "/", host, port);
    if (write_all(ws->fd, req, rlen) < 0) { close(ws->fd); ws->fd = -1; return -1; }

    /* Read 101 response */
    char line[512];
    while (_read_line(ws->fd, line, sizeof(line)) > 0) {
        if (line[0] == '\r' || line[0] == '\n') break;
    }
    return 0;
}

int y8_ws_send(y8_ws *ws, const char *data, int len) {
    /* Binary frame: opcode 0x02 */
    unsigned char hdr[14];
    int hlen = 0;
    hdr[0] = 0x82; /* FIN + binary */
    if (ws->is_server) {
        /* Server: no mask */
        if (len < 126) { hdr[1] = (unsigned char)len; hlen = 2; }
        else if (len < 65536) {
            hdr[1] = 126;
            hdr[2] = (len >> 8) & 0xFF;
            hdr[3] = len & 0xFF;
            hlen = 4;
        } else {
            hdr[1] = 127;
            memset(hdr+2, 0, 4);
            hdr[6] = (len >> 24) & 0xFF;
            hdr[7] = (len >> 16) & 0xFF;
            hdr[8] = (len >> 8) & 0xFF;
            hdr[9] = len & 0xFF;
            hlen = 10;
        }
    } else {
        /* Client: mask bit set, mask = 0 (XOR with 0 = identity) */
        if (len < 126) { hdr[1] = 0x80 | (unsigned char)len; hlen = 2; }
        else if (len < 65536) {
            hdr[1] = 0x80 | 126;
            hdr[2] = (len >> 8) & 0xFF;
            hdr[3] = len & 0xFF;
            hlen = 4;
        } else {
            hdr[1] = 0x80 | 127;
            memset(hdr+2, 0, 4);
            hdr[6] = (len >> 24) & 0xFF;
            hdr[7] = (len >> 16) & 0xFF;
            hdr[8] = (len >> 8) & 0xFF;
            hdr[9] = len & 0xFF;
            hlen = 10;
        }
        /* 4-byte mask key = 0 */
        memset(hdr + hlen, 0, 4);
        hlen += 4;
    }
    if (write_all(ws->fd, (char *)hdr, hlen) < 0) return -1;
    if (len > 0 && write_all(ws->fd, data, len) < 0) return -1;
    return 0;
}

int y8_ws_recv(y8_ws *ws, char **data, int *len) {
    unsigned char hdr[2];
    if (read_all(ws->fd, (char *)hdr, 2) < 0) return -1;

    int masked = (hdr[1] & 0x80) != 0;
    uint64_t plen = hdr[1] & 0x7F;

    if (plen == 126) {
        unsigned char ext[2];
        if (read_all(ws->fd, (char *)ext, 2) < 0) return -1;
        plen = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (plen == 127) {
        unsigned char ext[8];
        if (read_all(ws->fd, (char *)ext, 8) < 0) return -1;
        plen = 0;
        for (int i = 0; i < 8; i++) plen = (plen << 8) | ext[i];
    }

    unsigned char mask[4] = {0};
    if (masked) {
        if (read_all(ws->fd, (char *)mask, 4) < 0) return -1;
    }

    if (plen > (uint64_t)Y8_NET_MAX_MSG) return -1;
    char *buf = (char *)malloc((size_t)plen);
    if (!buf) return -1;
    if (plen > 0 && read_all(ws->fd, buf, (int)plen) < 0) { free(buf); return -1; }

    /* Unmask if needed */
    if (masked) {
        for (uint64_t i = 0; i < plen; i++)
            buf[i] ^= mask[i & 3];
    }

    /* Check for close frame (opcode 0x08) */
    if ((hdr[0] & 0x0F) == 0x08) { free(buf); return -1; }

    *data = buf;
    *len = (int)plen;
    return (int)plen;
}

void y8_ws_close(y8_ws *ws) {
    if (ws->fd >= 0) {
        /* Send close frame */
        unsigned char close_frame[2] = {0x88, 0x00};
        write(ws->fd, close_frame, 2);
        close(ws->fd);
        ws->fd = -1;
    }
}
