# Greenhouse Sensor Mesh

Multi-runtime IoT greenhouse monitor.  Four node types
communicate via y8_net transports.  React rules on each node
control which signals get accepted.

```
           y8_net (UDP sensors, TCP/WS others)
          ╱          │           ╲           ╲
   [sensor_1]    [estimator]   [dashboard]   [gateway]
    C / UDP       Bun / TCP     Bun / WS      Python
    readings      VPD calc      alerts+UI     REST API
```

## What it demonstrates

- **Four runtimes, one protocol** — C, JavaScript, Python nodes
  share QJSON wire format over y8_net transports
- **React rules** — `react({type: signal, from: From, fact: ...})`
  pattern-matched dispatch on every node
- **QJSON objects as terms** — signals are `{type: signal, from: From, fact: ...}`,
  no `obj([k-v,...])` ceremony
- **Spoofing protection** — `from: From, fact: reading(From, ...)`
  uses Prolog unification to verify sender matches fact
- **VPD estimation** — Magnus formula from temperature + humidity
- **Reactive alerts** — threshold violations detected by react rules
- **Transport options**:
  - Sensors → coordinator: **UDP** (fire-and-forget, lossy OK)
  - Estimator ↔ coordinator: **TCP** (reliable, framed)
  - Dashboard → browser: **WebSocket** (browser-compatible)
  - Gateway: **TCP** (REST bridge)
  - Tests: **SimBus** (in-memory, no network)

## Node roles

| Node | Runtime | Transport | Prolog engine |
|---|---|---|---|
| `sensor` | C | UDP | `prolog_core.c` |
| `estimator` | Bun/Node | TCP | `prolog-engine.js` |
| `dashboard` | Bun/Node | TCP + WebSocket | `prolog-engine.js` |
| `gateway` | Python | TCP | `prolog.py` |

## React rules (signal policy)

```prolog
% Coordinator accepts readings from online sensors
react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-
    node_id(coordinator),
    node_status(From, online),
    retractall(reading(From, Type, _V, _T)),
    assert(reading(From, Type, Val, Ts)),
    check_alerts(From, Type).

% Sensor accepts threshold updates from coordinator only
react({type: signal, from: coordinator, fact: threshold(Type, Min, Max)}) :-
    not(node_id(coordinator)),
    retractall(threshold(Type, _Min, _Max)),
    assert(threshold(Type, Min, Max)).
```

## Run (tests)

```bash
node examples/greenhouse/test.js    # 52 tests (SimBus, no network)
```

## Run (Docker)

```bash
cd examples/greenhouse
docker compose up --build
```

- Dashboard: http://localhost:3000
- Gateway API: http://localhost:8080/api/health

## Wire protocol

QJSON over y8_net framing:

```json
{ "kind": "signal", "from": "sensor_1", "fact": { "t": "c", "f": "reading", "a": [...] } }
```

Sensors use UDP datagrams (one signal per datagram).
All other nodes use TCP with length-prefix framing.
Browser dashboard uses WebSocket with binary frames.

## Transport throughput (y8_net benchmarks)

| Transport | msg/sec | Notes |
|-----------|--------:|-------|
| Pipe | 1.5M | SimBus tests |
| TCP | 2.2M | Estimator ↔ coordinator |
| WebSocket | 1.5M | Dashboard → browser |
| TLS | 700K | Encrypted channels |
| UDP | fire-and-forget | Sensor readings |

## Files

| File | Purpose |
|---|---|
| `greenhouse-kb.js` | React rules: signal policy, alerts, aggregation |
| `node.js` | GreenhouseNode: engine + transport + VPD |
| `test.js` | 52 tests (SimBus) |
| `sensor/main.c` | C sensor: prolog_core + UDP |
| `estimator/main.js` | Bun estimator: VPD + react rules |
| `gateway/main.py` | Python gateway: engine + HTTP |
| `dashboard/server.js` | Bun coordinator: react + HTTP + SSE |
| `dashboard/index.html` | Reactive dashboard UI |

## Signal flow

```
sensor_1 ──reading(UDP)──→ estimator ──estimate(TCP)──→ coordinator
sensor_1 ──reading(UDP)──→ coordinator                      │
sensor_2 ──reading(UDP)──→ estimator                        │ alert(TCP)
sensor_2 ──reading(UDP)──→ coordinator                      ↓
                                                        gateway → HTTP
coordinator ──threshold(UDP)──→ sensors
coordinator ──state(WS)──→ browser dashboard
```
