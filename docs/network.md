# y8 network — QJSON over wires

Loosely opinionated transport for y8 engines.  QJSON payloads
over four transports: TCP/TLS, UDP/DTLS, WebSocket, pipe.
Same framing, same wire format, same engine interface.

## Wire format

Every message is a length-prefixed QJSON payload:

```
┌──────────────┬─────────────────────────┐
│ 4 bytes      │ N bytes                 │
│ payload size │ QJSON (binary-safe)     │
│ big-endian   │ blobs via 0j            │
└──────────────┴─────────────────────────┘
```

- `size = 0` → keepalive ping (no payload)
- `size > 0` → QJSON message
- Maximum message size: 16 MB (configurable)
- QJSON is binary-safe: encrypted payloads, keys, checksums
  travel as `0j` blobs.  No base64.  No escaping.

## Transports

### TCP/TLS — reliable, encrypted

```c
y8_conn *c = y8_tcp_connect("host", 4433, tls_ctx);
y8_send(c, qjson_buf, qjson_len);     // length-prefix + write
y8_recv(c, &buf, &len);               // read length + read payload
y8_close(c);
```

- LibreSSL for TLS (or plaintext for local dev)
- Length-prefix framing over the TLS stream
- Application-level keepalive: ping every 30s, dead after 60s
- Auto-reconnect with exponential backoff (100ms → 200ms → ... → 10s)
- Use case: den-to-den, strata village, any reliable channel

### UDP/DTLS — fire-and-forget

```c
y8_conn *c = y8_udp_open("host", 4434, dtls_ctx);
y8_send(c, qjson_buf, qjson_len);     // one datagram = one message
y8_recv(c, &buf, &len);               // receive one datagram
y8_close(c);
```

- No framing needed: each UDP datagram IS one message
- DTLS for encryption (LibreSSL)
- No reconnection (stateless)
- No keepalive (stateless)
- Max message size: MTU (~1400 bytes with DTLS overhead)
- Use case: sensor readings, fire-and-forget telemetry

### WebSocket — browser-friendly

```c
y8_conn *c = y8_ws_connect("wss://host/path", tls_ctx);
y8_send(c, qjson_buf, qjson_len);     // one WS frame = one message
y8_recv(c, &buf, &len);               // receive one WS frame
y8_close(c);
```

- HTTP upgrade handshake, then framed binary messages
- WebSocket frames provide message boundaries (no length-prefix needed)
- wss:// for encryption (TLS via LibreSSL)
- Built-in ping/pong keepalive (WebSocket spec)
- Works through HTTP proxies and firewalls
- Use case: browser, sync-todo, any HTTP environment

### Pipe — local, zero overhead

```c
y8_conn *c = y8_pipe_open(read_fd, write_fd);   // stdio, socketpair
y8_send(c, qjson_buf, qjson_len);               // length-prefix + write
y8_recv(c, &buf, &len);                          // read length + read payload
y8_close(c);
```

- Length-prefix framing over file descriptors
- stdin/stdout for child processes
- Unix domain socket for same-machine IPC
- No encryption (same machine, same user)
- Use case: strata spawning dens, tool calls, Claude ↔ den

## Unified API

```c
/* Connection — opaque, transport-independent */
typedef struct y8_conn y8_conn;

/* Send a QJSON message.  Returns 0 on success, -1 on error. */
int y8_send(y8_conn *c, const char *data, int len);

/* Receive a QJSON message.  Caller frees *data.
   Returns payload length, 0 for keepalive, -1 on error. */
int y8_recv(y8_conn *c, char **data, int *len);

/* Close and free. */
void y8_close(y8_conn *c);

/* Connection state. */
int y8_connected(y8_conn *c);
const char *y8_error(y8_conn *c);
```

The engine doesn't know which transport it's using:

```prolog
react({type: signal, from: From, value: Val}) :-
    trusted(From),
    assert(reading(From, Val)),
    send(dashboard, {from: From, value: Val}).
```

Strata wires the transport when spawning the den.  The
rules don't change.

## Framing layer

Shared by TCP/TLS and pipe.  WebSocket and UDP have
built-in message boundaries.

```c
/* Write a length-prefixed frame.  Returns 0/-1. */
int y8_frame_write(int fd, const char *data, int len);
int y8_frame_write_ssl(SSL *ssl, const char *data, int len);

/* Read a length-prefixed frame.  Caller frees *data.
   Returns payload length, 0 for keepalive, -1 on error/EOF. */
int y8_frame_read(int fd, char **data, int *len);
int y8_frame_read_ssl(SSL *ssl, char **data, int *len);

/* Send keepalive (zero-length frame). */
int y8_frame_ping(int fd);
int y8_frame_ping_ssl(SSL *ssl);
```

Read is blocking but respects the 4-byte length prefix —
no partial messages, no merged messages.  Each call returns
exactly one complete QJSON payload.

## Keepalive protocol

For TCP/TLS and pipe:

- Sender: if no message sent for 30s, send ping (size=0)
- Receiver: if no message received for 60s, connection is dead
- On dead connection: close, attempt reconnect
- Reconnect: exponential backoff 100ms → 200ms → 400ms → ... → 10s cap

WebSocket: uses WS ping/pong (built-in, same 30s/60s timing).
UDP: no keepalive (stateless).

## Reconnection

TCP/TLS and WebSocket auto-reconnect on failure:

```
connected → send/recv normally
         → no data for 60s → dead
         → send/recv error → dead
dead      → close socket
         → wait backoff_ms
         → attempt connect
         → success → connected (backoff resets to 100ms)
         → failure → double backoff (cap 10s), retry
```

The engine sees: `y8_send` returns -1.  Next `y8_send`
attempts reconnect transparently.  Messages during
reconnection are lost (not queued — this is intentional;
the engine should resend if needed).

## Stress test

The framing layer is the critical path.  Test:

1. **Throughput**: send 1M messages, measure msg/sec
2. **Partial writes**: sender writes half a frame, pauses, writes rest
3. **Partial reads**: receiver reads 1 byte at a time
4. **Interleaved**: rapid send/recv on both ends simultaneously
5. **Large messages**: 1MB QJSON payloads
6. **Keepalive**: idle for 90s, verify connection stays alive
7. **Dead detection**: kill one end, verify other detects within 60s
8. **Reconnect**: kill server, restart, verify client reconnects
9. **Concurrent connections**: 100 simultaneous connections
10. **Binary safety**: send 0j blobs with all 256 byte values

## Files

```
native/
  y8_net.h          — unified API + framing declarations
  y8_net.c          — framing layer + pipe transport
  y8_net_tcp.c      — TCP/TLS transport (requires LibreSSL)
  y8_net_udp.c      — UDP/DTLS transport (requires LibreSSL)
  y8_net_ws.c       — WebSocket transport
  test_y8_net.c     — framing + pipe stress tests
```

Framing + pipe have zero dependencies (just POSIX).
TCP/TLS and UDP/DTLS require LibreSSL.
WebSocket requires the framing layer + HTTP upgrade (~80 lines).
