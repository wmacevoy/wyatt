// ============================================================
// estimator/main.js — Greenhouse VPD estimator node
//
// Listens on UDP for sensor readings, uses Prolog ephemeral/react
// rules to accept signals, computes VPD via the Magnus formula,
// and forwards estimates to the coordinator.
//
// Env vars:
//   LISTEN_PORT      — UDP port to bind (default 9500)
//   COORDINATOR_ADDR — host:port for the coordinator (default coordinator:9500)
// ============================================================

import dgram from "node:dgram";
import { PrologEngine } from "../../../src/prolog-engine.js";
import { loadString } from "../../../src/loader.js";
import { serialize, deserialize } from "../../../src/sync.js";

var atom     = PrologEngine.atom;
var variable = PrologEngine.variable;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;

// ── Configuration ───────────────────────────────────────────

var LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "9500", 10);
var COORDINATOR_ADDR = process.env.COORDINATOR_ADDR || "coordinator:9500";

function parseAddr(addr) {
  var idx = addr.lastIndexOf(":");
  if (idx === -1) {
    return { host: addr, port: 9500 };
  }
  return {
    host: addr.substring(0, idx),
    port: parseInt(addr.substring(idx + 1), 10)
  };
}

var coordinator = parseAddr(COORDINATOR_ADDR);

// ── Prolog engine setup ─────────────────────────────────────

var engine = new PrologEngine();

var RULES = [
  "react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-",
  "    node_role(estimator),",
  "    node_status(From, online),",
  "    retractall(reading(From, Type, _OldA, _OldB)),",
  "    assert(reading(From, Type, Val, Ts)),",
  "    try_vpd(From, Ts).",
  "",
  "try_vpd(Sensor, Ts) :-",
  "    reading(Sensor, temperature, Temp, _TempTs),",
  "    reading(Sensor, humidity, Hum, _HumTs),",
  "    compute_vpd(Temp, Hum, Vpd),",
  "    retractall(estimate(vpd, Sensor, _OldX, _OldY, _OldZ)),",
  "    assert(estimate(vpd, Sensor, Vpd, 100, Ts)),",
  "    send(coordinator, estimate(vpd, Sensor, Vpd, 100, Ts)).",
  "try_vpd(_AnySensor, _AnyTs).",
  "",
  "react({type: signal, from: From, fact: node_status(From, Status)}) :-",
  "    node_role(estimator),",
  "    retractall(node_status(From, _OldS)),",
  "    assert(node_status(From, Status))."
].join("\n");

loadString(engine, RULES);

engine.addClause(compound("node_role", [atom("estimator")]));
engine.addClause(compound("node_id",   [atom("estimator")]));

// compute_vpd/3 — Magnus formula for vapor pressure deficit
engine.builtins["compute_vpd/3"] = function(g, r, s, ctr, d, cb) {
  var temp = engine.deepWalk(g.args[0], s);
  var hum = engine.deepWalk(g.args[1], s);
  if (temp.type !== "num" || hum.type !== "num") return;
  var es = 0.6108 * Math.exp(17.27 * temp.value / (temp.value + 237.3));
  var ea = es * hum.value / 100;
  var vpd = Math.round((es - ea) * 100);
  var u = engine.unify(g.args[2], PrologEngine.num(vpd), s);
  if (u !== null) engine.solve(r, u, ctr, d + 1, cb);
};

// ── UDP transport ───────────────────────────────────────────

var sock = dgram.createSocket("udp4");

sock.on("error", function(err) {
  console.error("[estimator] socket error:", err.message);
  sock.close();
});

sock.on("message", function(msg, rinfo) {
  var payload;
  try {
    payload = JSON.parse(msg.toString());
  } catch (e) {
    console.error("[estimator] bad JSON from " + rinfo.address + ":" + rinfo.port);
    return;
  }

  if (!payload || payload.kind !== "signal") return;

  var fromId = payload.from;
  var fact   = deserialize(payload.fact);
  if (!fact || !fromId) return;

  // Track whether react rules mutated the DB (= signal accepted)
  var mutated = false;
  var markDirty = function() { mutated = true; };
  engine.onAssert.push(markDirty);
  engine.onRetract.push(markDirty);

  // Fire ephemeral with QJSON object event, collect sends
  engine._sends = [];
  engine.queryFirst(compound("ephemeral", [
    PrologEngine.object([
      { key: "type", value: atom("signal") },
      { key: "from", value: atom(fromId) },
      { key: "fact", value: fact }
    ])
  ]));
  var sends = engine._sends.slice();
  engine._sends = [];

  // Remove temporary mutation tracker
  engine.onAssert.pop();
  engine.onRetract.pop();

  if (!mutated) {
    console.log("[estimator] dropped signal from " + fromId +
                " (" + (fact.functor || fact.name || "?") + ")");
    return;
  }

  console.log("[estimator] accepted " + (fact.functor || fact.name) + " from " + fromId);

  // Dispatch all sends from Prolog react rules (e.g. VPD estimates)
  for (var i = 0; i < sends.length; i++) {
    var s = sends[i];
    var targetName = s.target.name;
    var targetAddr = parseAddr(targetName === "coordinator" ? COORDINATOR_ADDR : targetName + ":9500");
    var buf = Buffer.from(JSON.stringify({
      kind: "signal",
      from: "estimator",
      fact: serialize(s.fact)
    }));
    sock.send(buf, 0, buf.length, targetAddr.port, targetAddr.host, function(err) {
      if (err) {
        console.error("[estimator] failed to send:", err.message);
      } else {
        console.log("[estimator] sent " + (s.fact.functor || "fact") + " to " + targetName);
      }
    });
  }
});

sock.bind(LISTEN_PORT, function() {
  console.log("[estimator] node_id=estimator listening on UDP port " + LISTEN_PORT);
  console.log("[estimator] coordinator at " + coordinator.host + ":" + coordinator.port);
});

