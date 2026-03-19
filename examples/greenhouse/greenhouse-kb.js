// ============================================================
// greenhouse-kb.js — Prolog rules for greenhouse sensor mesh
//
// Four node roles: coordinator, sensor, estimator, gateway.
// Signal policy via ephemeral/react + alert detection + VPD.
// ============================================================

import { loadString } from "../../src/loader.js";

const GREENHOUSE_RULES = `
% ── Threshold defaults ───────────────────────────────────
threshold(temperature, 5, 40).
threshold(humidity, 20, 85).
threshold(vpd, 40, 160).

% ── React rules ──────────────────────────────────────────
% Pattern-match on QJSON object events via ephemeral/react.
% Spoofing protection: From in object must match From in fact.

% -- Coordinator --
react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-
    node_role(coordinator),
    node_status(From, online),
    retractall(reading(From, Type, _OldA, _OldB)),
    assert(reading(From, Type, Val, Ts)),
    check_alerts(From, Type).

check_alerts(Node, Type) :-
    alert(Node, Type, Level),
    send(gateway, alert_notice(Node, Type, Level)).
check_alerts(_AnyNode, _AnyType).

react({type: signal, from: estimator, fact: estimate(Type, Node, Val, Confidence, Ts)}) :-
    node_role(coordinator),
    retractall(estimate(Type, Node, _OldA, _OldB, _OldC)),
    assert(estimate(Type, Node, Val, Confidence, Ts)),
    send(gateway, estimate(Type, Node, Val, Confidence, Ts)).

react({type: signal, from: From, fact: node_status(From, Status)}) :-
    node_role(coordinator),
    retractall(node_status(From, _OldS)),
    assert(node_status(From, Status)).

% -- Estimator --
react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-
    node_role(estimator),
    node_status(From, online),
    retractall(reading(From, Type, _OldA, _OldB)),
    assert(reading(From, Type, Val, Ts)),
    try_vpd(From, Ts).

try_vpd(Sensor, Ts) :-
    reading(Sensor, temperature, Temp, _TempTs),
    reading(Sensor, humidity, Hum, _HumTs),
    compute_vpd(Temp, Hum, Vpd),
    retractall(estimate(vpd, Sensor, _OldX, _OldY, _OldZ)),
    assert(estimate(vpd, Sensor, Vpd, 100, Ts)),
    send(coordinator, estimate(vpd, Sensor, Vpd, 100, Ts)).
try_vpd(_AnySensor, _AnyTs).

react({type: signal, from: From, fact: node_status(From, Status)}) :-
    node_role(estimator),
    retractall(node_status(From, _OldS)),
    assert(node_status(From, Status)).

% -- Gateway --
react({type: signal, from: coordinator, fact: estimate(Type, Node, Val, Confidence, Ts)}) :-
    node_role(gateway),
    retractall(estimate(Type, Node, _OldA, _OldB, _OldC)),
    assert(estimate(Type, Node, Val, Confidence, Ts)).

react({type: signal, from: coordinator, fact: alert_notice(Node, Type, Level)}) :-
    node_role(gateway),
    retractall(alert_notice(Node, Type, _OldL)),
    assert(alert_notice(Node, Type, Level)).

% -- Sensor --
react({type: signal, from: coordinator, fact: calibration(Sensor, Type, Offset)}) :-
    node_role(sensor),
    retractall(calibration(Sensor, Type, _OldO)),
    assert(calibration(Sensor, Type, Offset)).

react({type: signal, from: coordinator, fact: threshold(Type, Min, Max)}) :-
    node_role(sensor),
    retractall(threshold(Type, _OldA, _OldB)),
    assert(threshold(Type, Min, Max)).

% No catch-all — unmatched signals are dropped

% ── Alert detection ──────────────────────────────────────
alert(Node, temperature, high) :-
    reading(Node, temperature, Val, Ts),
    threshold(temperature, Min, Max),
    Val > Max.

alert(Node, temperature, low) :-
    reading(Node, temperature, Val, Ts),
    threshold(temperature, Min, Max),
    Val < Min.

alert(Node, humidity, high) :-
    reading(Node, humidity, Val, Ts),
    threshold(humidity, Min, Max),
    Val > Max.

alert(Node, humidity, low) :-
    reading(Node, humidity, Val, Ts),
    threshold(humidity, Min, Max),
    Val < Min.

alert(Node, vpd, high) :-
    estimate(vpd, Node, Val, Confidence, Ts),
    threshold(vpd, Min, Max),
    Val > Max.

alert(Node, vpd, low) :-
    estimate(vpd, Node, Val, Confidence, Ts),
    threshold(vpd, Min, Max),
    Val < Min.

% ── Aggregation ──────────────────────────────────────────
all_alerts(Alerts) :-
    findall(alert(N, T, L), alert(N, T, L), Alerts).

node_readings(Node, Readings) :-
    findall(reading(Node, T, V, Ts), reading(Node, T, V, Ts), Readings).

online_nodes(Nodes) :-
    findall(N, node_status(N, online), Nodes).

% ── Status ───────────────────────────────────────────────
mesh_status(critical) :- alert(A, B, C).
mesh_status(normal) :- not(alert(A, B, C)).
`;

export const GREENHOUSE_PROLOG_SOURCE = GREENHOUSE_RULES;

/**
 * Build the greenhouse KB for a specific node.
 * @param {Function} PrologEngine
 * @param {string} nodeId
 * @param {string} role — "coordinator", "sensor", "estimator", "gateway"
 * @returns {PrologEngine}
 */
export function buildGreenhouseKB(PrologEngine, nodeId, role) {
  const engine = new PrologEngine();
  loadString(engine, GREENHOUSE_RULES);

  // Set this node's identity and role
  engine.addClause(PrologEngine.compound("node_id", [PrologEngine.atom(nodeId)]));
  engine.addClause(PrologEngine.compound("node_role", [PrologEngine.atom(role)]));

  // list_length/2 builtin
  engine.builtins["list_length/2"] = function(g, r, s, ctr, d, cb) {
    var lst = engine.deepWalk(g.args[0], s);
    var items = [];
    while (lst && lst.type === "compound" && lst.functor === "." && lst.args.length === 2) {
      items.push(lst.args[0]);
      lst = lst.args[1];
    }
    var u = engine.unify(g.args[1], PrologEngine.num(items.length), s);
    if (u !== null) engine.solve(r, u, ctr, d + 1, cb);
  };

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

  return engine;
}
