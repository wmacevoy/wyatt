# y8 network — QJSON over wires

Four transports, one wire format, ~570 lines of C.
POSIX only. LibreSSL optional for TLS.

## Results

| Transport | Throughput | Use case |
|-----------|-----------|----------|
| Pipe (socketpair) | 1.5M msg/sec | Local IPC, child processes |
| TCP (localhost) | 2.2M msg/sec | Den-to-den, strata village |
| WebSocket | 1.5M msg/sec | Browser clients |
| TLS (RSA-2048) | 700K msg/sec | Encrypted channels |
| UDP | fire-and-forget | Sensor readings |

64 tests.  Fork-based (y8's model: isolated single-threaded
processes).

## Wire format

### Pipe + TCP + TLS

Length-prefixed QJSON:

```
┌──────────────┬─────────────────────────┐
│ 4 bytes      │ N bytes                 │
│ payload size │ QJSON (binary-safe)     │
│ big-endian   │ blobs via 0j            │
└──────────────┴─────────────────────────┘
```

`size = 0` → keepalive ping.  Max 16 MB.

### WebSocket

Binary WS frames (opcode 0x02).  Each frame = one QJSON
message.  No length-prefix needed (WS frames have boundaries).

### UDP

Raw datagrams.  Each datagram = one QJSON message.
No framing.  Max ~65KB.

## API

```c
/* ── Framing (shared by pipe, TCP, TLS) ──────────── */
int y8_frame_write(int fd, const char *data, int len);
int y8_frame_read(int fd, char **data, int *len);
int y8_frame_ping(int fd);

/* ── Pipe ────────────────────────────────────────── */
y8_pipe p;
y8_pipe_init(&p, read_fd, write_fd);
y8_pipe_send(&p, data, len);
y8_pipe_recv(&p, &data, &len);
y8_pipe_close(&p);

/* ── TCP ─────────────────────────────────────────── */
int server_fd = y8_tcp_listen(port);   // 0 = ephemeral
int conn_fd = y8_tcp_accept(server_fd);
int client_fd = y8_tcp_connect("host", port);
// Then use y8_frame_write/read on the fd.

/* ── TCP with auto-reconnect ────────────────────── */
y8_tcp_conn c;
y8_tcp_conn_init(&c, "host", port, tls);  // tls=NULL for plain
y8_tcp_conn_send(&c, data, len);           // reconnects on failure
y8_tcp_conn_recv(&c, &data, &len);
y8_tcp_conn_close(&c);

/* ── TLS ─────────────────────────────────────────── */
y8_tls_ctx *stls = y8_tls_server("cert.pem", "key.pem");
y8_tls_ctx *ctls = y8_tls_client(NULL);  // NULL = no verify
int conn = y8_tcp_accept_tls(server_fd, stls, &ssl);
y8_frame_write_ssl(ssl, data, len);
y8_frame_read_ssl(ssl, &data, &len);
y8_tls_free(stls);

/* ── UDP ─────────────────────────────────────────── */
int fd = y8_udp_open(port);  // 0 = ephemeral
y8_udp_send(fd, "host", port, data, len);
y8_udp_recv(fd, &data, &len);

/* ── WebSocket ───────────────────────────────────── */
y8_ws ws;
y8_ws_connect(&ws, "host", port, "/path");  // client
y8_ws_accept(&ws, tcp_fd);                   // server
y8_ws_send(&ws, data, len);                  // binary frame
y8_ws_recv(&ws, &data, &len);
y8_ws_close(&ws);
```

## Auto-reconnect

`y8_tcp_conn` detects broken connections via `recv(MSG_PEEK)`
and reconnects with exponential backoff:

```
1ms → 2ms → 4ms → ... → 4096ms (cap)
```

On successful reconnect, backoff resets to 1ms.  TLS sessions
re-handshake on reconnect (session resumption is possible with
LibreSSL but not yet implemented).

## Files

```
native/
  y8_net.h          — unified API (all transports)
  y8_net.c          — implementation (~570 lines)
  test_y8_net.c     — 64 tests (fork-based stress)
```

Zero dependencies for pipe + TCP + UDP + WebSocket.
Add `-lssl -lcrypto` for TLS.

## Transport selection

The engine doesn't know which transport it's using.
Strata wires the transport when spawning a den:

```prolog
% These rules work over any transport
react({type: signal, from: From, value: Val}) :-
    trusted(From),
    assert(reading(From, Val)),
    send(dashboard, {from: From, value: Val}).
```

| Environment | Transport | Why |
|------------|-----------|-----|
| Same machine | Pipe | Zero overhead, no encryption needed |
| LAN / datacenter | TCP/TLS | Reliable, encrypted |
| IoT sensors | UDP | Fire-and-forget, lossy OK |
| Browser | WebSocket | Only option through HTTP |
| Behind firewall | WebSocket (wss://) | Tunnels through HTTP proxy |
