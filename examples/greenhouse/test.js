// ============================================================
// test.js — Tests for greenhouse sensor mesh
//
// Run:  node examples/greenhouse/test.js
//       bun run examples/greenhouse/test.js
// ============================================================

import { PrologEngine, termToString, listToArray } from "../../src/prolog-engine.js";
import { serialize, deserialize, termEq } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { SimBus } from "../nng-mesh/transport.js";
import { buildGreenhouseKB } from "./greenhouse-kb.js";
import { GreenhouseNode } from "./node.js";

const { atom, variable, compound, num, object: obj } = PrologEngine;

// ── Test framework ──────────────────────────────────────────

let _suite = "", _pass = 0, _fail = 0;
function describe(name, fn) { _suite = name; console.log(`\n  ${name}`); fn(); }
function it(name, fn) {
  try { fn(); _pass++; console.log(`    \u2713 ${name}`); }
  catch(e) { _fail++; console.log(`    \u2717 ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(a === b, msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Helper: create a greenhouse mesh ─────────────────────

function createMesh(nodes) {
  const bus = new SimBus();
  const mesh = {};
  for (const { id, role } of nodes) {
    const transport = bus.createTransport(id);
    mesh[id] = new GreenhouseNode({ id, role, transport });
  }
  return { bus, nodes: mesh };
}

function fullMesh() {
  return createMesh([
    { id: "coordinator", role: "coordinator" },
    { id: "sensor_1", role: "sensor" },
    { id: "sensor_2", role: "sensor" },
    { id: "estimator", role: "estimator" },
    { id: "gateway", role: "gateway" }
  ]);
}

// ── Helper: build engine for policy tests ───────────────
// ephemeral/1 is a built-in that fires _fireReact → react rules.

function buildTestKB(nodeId, role) {
  return buildGreenhouseKB(PrologEngine, nodeId, role);
}

// ── Helper: fire a signal via ephemeral and detect acceptance ──

function fireSignal(engine, fromAddress, fact) {
  let mutated = false;
  const markDirty = function() { mutated = true; };
  engine.onAssert.push(markDirty);
  engine.onRetract.push(markDirty);

  engine._sends = [];
  engine.queryFirst(compound("ephemeral", [
    obj([
      { key: "type", value: atom("signal") },
      { key: "from", value: atom(fromAddress) },
      { key: "fact", value: fact }
    ])
  ]));
  const sends = engine._sends.slice();
  engine._sends = [];

  engine.onAssert.pop();
  engine.onRetract.pop();

  return { accepted: mutated, sends: sends };
}

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

// ── Greenhouse KB rules ─────────────────────────────────────

describe("Greenhouse KB rules", () => {
  it("has default thresholds", () => {
    const e = buildGreenhouseKB(PrologEngine, "test", "coordinator");
    const r = e.queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
    assert(r !== null);
    eq(r.args[1].value, 5);
    eq(r.args[2].value, 40);
  });

  it("detects high temperature alert", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(45), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("temperature"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "high");
  });

  it("detects low temperature alert", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(2), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("temperature"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "low");
  });

  it("no alerts when reading within range", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]));
    const r = e.queryFirst(compound("alert", [variable("N"), variable("T"), variable("L")]));
    eq(r, null);
  });

  it("detects high humidity alert", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("humidity"), num(90), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("humidity"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "high");
  });

  it("detects high VPD alert from estimate", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("estimate", [atom("vpd"), atom("s1"), num(200), num(100), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("vpd"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "high");
  });

  it("mesh_status normal with no readings", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    const r = e.queryFirst(compound("mesh_status", [variable("S")]));
    assert(r !== null);
    eq(r.args[0].name, "normal");
  });

  it("mesh_status critical with alert", () => {
    const e = buildGreenhouseKB(PrologEngine, "coord", "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(50), num(1000)]));
    const r = e.queryFirst(compound("mesh_status", [variable("S")]));
    assert(r !== null);
    eq(r.args[0].name, "critical");
  });
});

// ── Signal policy: coordinator ──────────────────────────────

describe("Signal policy — coordinator", () => {
  it("accepts reading from online sensor", () => {
    const e = buildTestKB("coordinator", "coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s1", fact);
    assert(r.accepted, "should accept reading");
    const reading = e.queryFirst(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("T")]));
    eq(reading.args[2].value, 22);
  });

  it("rejects reading from unknown sensor", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s1", fact);
    eq(r.accepted, false);
  });

  it("rejects spoofed reading (From mismatch)", () => {
    const e = buildTestKB("coordinator", "coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s2", fact);
    eq(r.accepted, false);
  });

  it("accepts estimate from estimator", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("estimate", [atom("vpd"), atom("s1"), num(80), num(100), num(1000)]);
    const r = fireSignal(e, "estimator", fact);
    assert(r.accepted, "should accept estimate");
    const est = e.queryFirst(compound("estimate", [atom("vpd"), atom("s1"), variable("V"), variable("C"), variable("T")]));
    eq(est.args[2].value, 80);
  });

  it("rejects estimate from non-estimator", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("estimate", [atom("vpd"), atom("s1"), num(80), num(100), num(1000)]);
    const r = fireSignal(e, "rogue", fact);
    eq(r.accepted, false);
  });

  it("accepts node_status from anyone", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("node_status", [atom("new_node"), atom("online")]);
    const r = fireSignal(e, "new_node", fact);
    assert(r.accepted, "should accept node_status");
    const status = e.queryFirst(compound("node_status", [atom("new_node"), variable("S")]));
    eq(status.args[1].name, "online");
  });
});

// ── Signal policy: sensor ───────────────────────────────────

describe("Signal policy — sensor", () => {
  it("accepts calibration from coordinator", () => {
    const e = buildTestKB("sensor_1", "sensor");
    const fact = compound("calibration", [atom("sensor_1"), atom("temperature"), num(2)]);
    const r = fireSignal(e, "coordinator", fact);
    assert(r.accepted, "should accept calibration");
  });

  it("accepts threshold from coordinator", () => {
    const e = buildTestKB("sensor_1", "sensor");
    const fact = compound("threshold", [atom("temperature"), num(0), num(50)]);
    const r = fireSignal(e, "coordinator", fact);
    assert(r.accepted, "should accept threshold");
    const th = e.queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
    eq(th.args[1].value, 0);
    eq(th.args[2].value, 50);
  });

  it("ignores readings from other nodes", () => {
    const e = buildTestKB("sensor_1", "sensor");
    const fact = compound("reading", [atom("s2"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s2", fact);
    eq(r.accepted, false);
  });

  it("ignores calibration from non-coordinator", () => {
    const e = buildTestKB("sensor_1", "sensor");
    const fact = compound("calibration", [atom("sensor_1"), atom("temperature"), num(2)]);
    const r = fireSignal(e, "rogue", fact);
    eq(r.accepted, false);
  });
});

// ── Signal policy: estimator ────────────────────────────────

describe("Signal policy — estimator", () => {
  it("accepts reading from online sensor", () => {
    const e = buildTestKB("estimator", "estimator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s1", fact);
    assert(r.accepted, "should accept reading");
  });

  it("rejects reading from offline sensor", () => {
    const e = buildTestKB("estimator", "estimator");
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s1", fact);
    eq(r.accepted, false);
  });

  it("ignores calibration signals", () => {
    const e = buildTestKB("estimator", "estimator");
    const fact = compound("calibration", [atom("s1"), atom("temperature"), num(2)]);
    const r = fireSignal(e, "coordinator", fact);
    eq(r.accepted, false);
  });
});

// ── Signal policy: gateway ──────────────────────────────────

describe("Signal policy — gateway", () => {
  it("accepts estimate from coordinator", () => {
    const e = buildTestKB("gateway", "gateway");
    const fact = compound("estimate", [atom("vpd"), atom("s1"), num(80), num(100), num(1000)]);
    const r = fireSignal(e, "coordinator", fact);
    assert(r.accepted, "should accept estimate");
    const est = e.queryFirst(compound("estimate", [atom("vpd"), atom("s1"), variable("V"), variable("C"), variable("T")]));
    eq(est.args[2].value, 80);
  });

  it("accepts alert_notice from coordinator", () => {
    const e = buildTestKB("gateway", "gateway");
    const fact = compound("alert_notice", [atom("s1"), atom("temperature"), atom("high")]);
    const r = fireSignal(e, "coordinator", fact);
    assert(r.accepted, "should accept alert_notice");
  });

  it("ignores readings", () => {
    const e = buildTestKB("gateway", "gateway");
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const r = fireSignal(e, "s1", fact);
    eq(r.accepted, false);
  });

  it("rejects estimate from non-coordinator", () => {
    const e = buildTestKB("gateway", "gateway");
    const fact = compound("estimate", [atom("vpd"), atom("s1"), num(80), num(100), num(1000)]);
    const r = fireSignal(e, "rogue", fact);
    eq(r.accepted, false);
  });
});

// ── GreenhouseNode integration ──────────────────────────────

describe("GreenhouseNode integration", () => {
  it("sensor sends reading, coordinator accepts it", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(23), num(1000)]));

    const r = coord.queryFirst(
      compound("reading", [atom("sensor_1"), atom("temperature"), variable("V"), variable("T")]));
    assert(r !== null);
    eq(r.args[2].value, 23);
  });

  it("coordinator rejects reading from unknown sensor", () => {
    const { nodes } = fullMesh();
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(99), num(1000)]));

    const r = nodes.coordinator.queryFirst(
      compound("reading", [atom("sensor_1"), variable("T"), variable("V"), variable("Ts")]));
    eq(r, null);
    eq(nodes.coordinator._signalLog[0].accepted, false);
  });

  it("reading upserts (replaces old value)", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(20), num(100)]));
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(30), num(200)]));

    const readings = coord.query(
      compound("reading", [atom("sensor_1"), atom("temperature"), variable("V"), variable("T")]));
    eq(readings.length, 1);
    eq(readings[0].args[2].value, 30);
  });

  it("node_status auto-registers sensor", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;

    nodes.sensor_1.send("coordinator",
      compound("node_status", [atom("sensor_1"), atom("online")]));

    const r = coord.queryFirst(compound("node_status", [atom("sensor_1"), variable("S")]));
    assert(r !== null);
    eq(r.args[1].name, "online");

    // Now readings should be accepted
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(22), num(100)]));
    const reading = coord.queryFirst(
      compound("reading", [atom("sensor_1"), variable("T"), variable("V"), variable("Ts")]));
    assert(reading !== null);
  });

  it("spoofed From is rejected", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    nodes.sensor_2.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(99), num(1000)]));

    const r = coord.queryFirst(
      compound("reading", [atom("sensor_1"), variable("T"), variable("V"), variable("Ts")]));
    eq(r, null);
    eq(coord._signalLog[0].accepted, false);
  });

  it("coordinator pushes threshold to sensor", () => {
    const { nodes } = fullMesh();
    nodes.coordinator.send("sensor_1",
      compound("threshold", [atom("temperature"), num(0), num(50)]));

    eq(nodes.sensor_1._signalLog[0].accepted, true);
    // Verify upserted
    const th = nodes.sensor_1.queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
    eq(th.args[1].value, 0);
    eq(th.args[2].value, 50);
  });

  it("sensor ignores calibration from non-coordinator", () => {
    const { nodes } = fullMesh();
    nodes.sensor_2.send("sensor_1",
      compound("calibration", [atom("sensor_1"), atom("temperature"), num(5)]));

    eq(nodes.sensor_1._signalLog[0].accepted, false);
  });
});

// ── Estimator VPD computation ───────────────────────────────

describe("Estimator VPD computation", () => {
  it("computes VPD when both temp and humidity arrive", () => {
    const { nodes } = fullMesh();
    const est = nodes.estimator;
    est.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    // Send temperature
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(25), num(1000)]));
    let vpd = est.queryFirst(compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));
    eq(vpd, null, "no VPD with only temperature");

    // Send humidity
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("humidity"), num(60), num(1001)]));
    vpd = est.queryFirst(compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));
    assert(vpd !== null, "VPD should be computed");
    assert(vpd.args[2].value > 0, "VPD should be positive");
  });

  it("sends VPD estimate to coordinator", () => {
    const { nodes } = fullMesh();
    const est = nodes.estimator;
    const coord = nodes.coordinator;
    est.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(25), num(1000)]));
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("humidity"), num(60), num(1001)]));

    const r = coord.queryFirst(
      compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));
    assert(r !== null, "coordinator should have VPD estimate");
  });

  it("updates VPD when new readings arrive", () => {
    const { nodes } = fullMesh();
    const est = nodes.estimator;
    est.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    // First pair
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(25), num(1000)]));
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("humidity"), num(60), num(1001)]));
    const vpd1 = est.queryFirst(
      compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));

    // Higher temperature → higher VPD
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(35), num(2000)]));
    const vpd2 = est.queryFirst(
      compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));

    assert(vpd2.args[2].value > vpd1.args[2].value, "VPD should increase with temperature");
  });
});

// ── send/2 integration ──────────────────────────────────────

describe("send/2 integration", () => {
  it("coordinator forwards estimate to gateway via send/2", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("estimate", [atom("vpd"), atom("s1"), num(80), num(100), num(1000)]);
    const result = fireSignal(e, "estimator", fact);
    assert(result.accepted, "should accept estimate");
    eq(result.sends.length, 1, "should have one send");
    eq(result.sends[0].target.name, "gateway");
    eq(result.sends[0].fact.functor, "estimate");
  });

  it("coordinator produces no sends for normal reading", () => {
    const e = buildTestKB("coordinator", "coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const result = fireSignal(e, "s1", fact);
    assert(result.accepted, "should accept reading");
    eq(result.sends.length, 0, "no sends for a normal reading");
  });

  it("coordinator auto-sends alert_notice to gateway on high reading", () => {
    const e = buildTestKB("coordinator", "coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(50), num(1000)]);
    const result = fireSignal(e, "s1", fact);
    assert(result.accepted, "should accept reading");
    eq(result.sends.length, 1, "should send alert_notice");
    eq(result.sends[0].target.name, "gateway");
    eq(result.sends[0].fact.functor, "alert_notice");
    eq(result.sends[0].fact.args[2].name, "high");
  });

  it("estimator sends VPD estimate via send/2", () => {
    const e = buildTestKB("estimator", "estimator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    // Send temperature first
    fireSignal(e, "s1",
      compound("reading", [atom("s1"), atom("temperature"), num(25), num(1000)]));
    // Send humidity — should trigger VPD computation + send
    const result = fireSignal(e, "s1",
      compound("reading", [atom("s1"), atom("humidity"), num(60), num(1001)]));
    assert(result.accepted, "should accept humidity reading");
    eq(result.sends.length, 1, "should send VPD estimate");
    eq(result.sends[0].target.name, "coordinator");
    eq(result.sends[0].fact.functor, "estimate");
    eq(result.sends[0].fact.args[0].name, "vpd");
  });

  it("estimator produces no send with only temperature", () => {
    const e = buildTestKB("estimator", "estimator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const result = fireSignal(e, "s1",
      compound("reading", [atom("s1"), atom("temperature"), num(25), num(1000)]));
    assert(result.accepted, "should accept reading");
    eq(result.sends.length, 0, "no sends without both readings");
  });

  it("dropped signal produces no sends", () => {
    const e = buildTestKB("coordinator", "coordinator");
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    const result = fireSignal(e, "s1", fact);
    eq(result.accepted, false, "should reject (sensor not online)");
    eq(result.sends.length, 0);
  });

  it("full mesh: estimator VPD flows through coordinator to gateway", () => {
    const { nodes } = fullMesh();
    const est = nodes.estimator;
    const coord = nodes.coordinator;
    const gw = nodes.gateway;

    // Register sensor on both estimator and coordinator
    est.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    // Sensor sends readings to estimator
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(25), num(1000)]));
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("humidity"), num(60), num(1001)]));

    // Estimator computes VPD and sends to coordinator (via send/2)
    // Coordinator receives estimate and forwards to gateway (via send/2)
    const gwEstimate = gw.queryFirst(
      compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));
    assert(gwEstimate !== null, "gateway should have VPD estimate via send/2 chain");
    assert(gwEstimate.args[2].value > 0, "VPD should be positive");
  });
});

// ── Reactive integration ────────────────────────────────────

describe("Reactive integration", () => {
  it("alert memo recomputes when reading arrives", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    const alerts = coord.reactive.createQuery(() =>
      compound("alert", [variable("N"), variable("T"), variable("L")]));
    eq(alerts().length, 0);

    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(50), num(1000)]));
    eq(alerts().length, 1);
    eq(alerts()[0].args[2].name, "high");
  });

  it("mesh_status transitions normal → critical", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));

    const status = coord.reactive.createQueryFirst(() =>
      compound("mesh_status", [variable("S")]));
    eq(status().args[0].name, "normal");

    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(50), num(1000)]));
    eq(status().args[0].name, "critical");
  });

  it("online_nodes updates with registrations", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;

    const onlineNodes = coord.reactive.createQueryFirst(() =>
      compound("online_nodes", [variable("N")]));
    eq(listToArray(onlineNodes().args[0]).length, 0);

    nodes.sensor_1.send("coordinator",
      compound("node_status", [atom("sensor_1"), atom("online")]));
    eq(listToArray(onlineNodes().args[0]).length, 1);

    nodes.sensor_2.send("coordinator",
      compound("node_status", [atom("sensor_2"), atom("online")]));
    eq(listToArray(onlineNodes().args[0]).length, 2);
  });
});

// ── End-to-end scenario ─────────────────────────────────────

describe("End-to-end scenario", () => {
  it("full lifecycle: register → read → estimate → alert → gateway", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;
    const est = nodes.estimator;
    const gw = nodes.gateway;

    // 1. Sensors register
    nodes.sensor_1.send("coordinator",
      compound("node_status", [atom("sensor_1"), atom("online")]));
    nodes.sensor_1.send("estimator",
      compound("node_status", [atom("sensor_1"), atom("online")]));

    // 2. Sensor sends readings → estimator computes VPD → coordinator gets estimate
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(38), num(100)]));
    nodes.sensor_1.send("estimator",
      compound("reading", [atom("sensor_1"), atom("humidity"), num(30), num(101)]));

    // 3. Coordinator should have VPD estimate
    const estimate = coord.queryFirst(
      compound("estimate", [atom("vpd"), atom("sensor_1"), variable("V"), variable("C"), variable("T")]));
    assert(estimate !== null, "coordinator should have VPD estimate");

    // 4. Sensor sends direct readings to coordinator too
    //    High temperature triggers check_alerts → send(gateway, alert_notice(...))
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(45), num(200)]));

    const status = coord.queryFirst(compound("mesh_status", [variable("S")]));
    eq(status.args[0].name, "critical");

    // 5. Alert notice auto-forwarded to gateway via check_alerts/send/2
    const gwAlert = gw.queryFirst(
      compound("alert_notice", [variable("N"), variable("T"), variable("L")]));
    assert(gwAlert !== null, "gateway should have alert notice via send/2");
    eq(gwAlert.args[2].name, "high");
  });

  it("sensor goes offline, readings rejected", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;

    nodes.sensor_1.send("coordinator",
      compound("node_status", [atom("sensor_1"), atom("online")]));
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(22), num(100)]));
    assert(coord.queryFirst(compound("reading", [atom("sensor_1"), variable("T"), variable("V"), variable("Ts")])) !== null);

    // Go offline (direct engine manipulation for test setup)
    coord.engine.retractFirst(compound("node_status", [atom("sensor_1"), variable("S")]));
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("offline")]));

    // New reading rejected
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(30), num(200)]));
    const r = coord.queryFirst(
      compound("reading", [atom("sensor_1"), atom("temperature"), variable("V"), variable("Ts")]));
    eq(r.args[2].value, 22, "should still have old reading");
  });

  it("threshold update propagates to sensors", () => {
    const { nodes } = fullMesh();

    nodes.coordinator.send("sensor_1",
      compound("threshold", [atom("temperature"), num(0), num(50)]));
    nodes.coordinator.send("sensor_2",
      compound("threshold", [atom("temperature"), num(0), num(50)]));

    eq(nodes.sensor_1._signalLog[0].accepted, true);
    eq(nodes.sensor_2._signalLog[0].accepted, true);
  });

  it("signal log tracks all decisions", () => {
    const { nodes } = fullMesh();
    const coord = nodes.coordinator;

    // Unknown sensor → dropped
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(22), num(100)]));
    eq(coord._signalLog[0].accepted, false);

    // Register → accepted
    nodes.sensor_1.send("coordinator",
      compound("node_status", [atom("sensor_1"), atom("online")]));
    eq(coord._signalLog[1].accepted, true);

    // Now reading accepted
    nodes.sensor_1.send("coordinator",
      compound("reading", [atom("sensor_1"), atom("temperature"), num(22), num(100)]));
    eq(coord._signalLog[2].accepted, true);

    eq(coord._signalLog.length, 3);
  });
});

// ── Persistence ─────────────────────────────────────────────

// In-memory mock adapter (semantic interface, no SQLite needed for tests)
function MockAdapter() { this._rows = {}; }
MockAdapter.prototype.setup = function() {};
MockAdapter.prototype.insert = function(key) { this._rows[key] = true; };
MockAdapter.prototype.remove = function(key) { delete this._rows[key]; };
MockAdapter.prototype.all = function() { return Object.keys(this._rows); };
MockAdapter.prototype.commit = function() {};
MockAdapter.prototype.close = function() {};

describe("Persistence", function() {
  it("coordinator readings survive restart", function() {
    const db = new MockAdapter();
    const bus = new SimBus();

    const coord1 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator"), db
    });

    // Register sensor + send a reading
    coord1.engine.queryFirst(compound("assert",
      [compound("node_status", [atom("sensor_1"), atom("online")])]));
    coord1._handleSignal("sensor_1", {
      kind: "signal", from: "sensor_1",
      fact: serialize(compound("reading",
        [atom("sensor_1"), atom("temperature"), num(25), num(1000)]))
    });

    const r1 = coord1.queryFirst(compound("reading",
      [atom("sensor_1"), atom("temperature"), variable("V"), variable("T")]));
    assert(r1 !== null, "reading should be accepted");
    eq(r1.args[2].value, 25);

    // "Restart": new coordinator, same DB
    const coord2 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator2"), db
    });

    const r2 = coord2.queryFirst(compound("reading",
      [atom("sensor_1"), atom("temperature"), variable("V"), variable("T")]));
    assert(r2 !== null, "reading should survive restart");
    eq(r2.args[2].value, 25);
  });

  it("threshold updates persist", function() {
    const db = new MockAdapter();
    const bus = new SimBus();

    const coord1 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator"), db
    });

    // Update threshold via assert (retractall + assert pattern)
    coord1.engine.queryFirst(compound("retractall",
      [compound("threshold", [atom("temperature"), variable("_"), variable("_")])]));
    coord1.engine.queryFirst(compound("assert",
      [compound("threshold", [atom("temperature"), num(10), num(35)])]));

    // Restart
    const coord2 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator2"), db
    });

    // Should have BOTH default threshold (from loadString) AND persisted one
    const thresholds = coord2.engine.query(compound("threshold",
      [atom("temperature"), variable("Min"), variable("Max")]));
    // The persisted one should be present
    const persisted = thresholds.find(t => t.args[1].value === 10 && t.args[2].value === 35);
    assert(persisted, "persisted threshold should survive restart");
  });

  it("node_status persists across restart", function() {
    const db = new MockAdapter();
    const bus = new SimBus();

    const coord1 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator"), db
    });
    coord1._handleSignal("sensor_1", {
      kind: "signal", from: "sensor_1",
      fact: serialize(compound("node_status", [atom("sensor_1"), atom("online")]))
    });

    const coord2 = new GreenhouseNode({
      id: "coordinator", role: "coordinator",
      transport: bus.createTransport("coordinator2"), db
    });
    const status = coord2.queryFirst(compound("node_status",
      [atom("sensor_1"), variable("S")]));
    assert(status !== null, "node_status should survive restart");
    eq(status.args[1].name, "online");
  });
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n  ${_pass} passing, ${_fail} failing`);
if (_fail > 0) process.exit(1);
