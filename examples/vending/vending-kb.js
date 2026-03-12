// ============================================================
// Vending Machine Knowledge Base
//
// The entire machine policy — what to do given any combination
// of sensor state, credit, and faults — expressed as Prolog
// clauses.  No imperative state machine.  No if/else chains.
// Just rules and the inference engine finds the right action.
//
// Dynamic state (via assert/retract):
//   machine_state(State)      — idle, vending, fault, ...
//   credit(Cents)             — current credit in machine
//   sensor(Name, Value)       — last known sensor readings
//   fault(Code)               — active faults
//   inventory(Slot, Count)    — items remaining per slot
//   selection(Slot)           — user's current selection
//   vend_step(Step)           — progress through vend sequence
//
// The reactive layer watches sensor signals and bumps the
// engine after each sensor update.  Effects query the engine
// for what action to take.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
const { atom: at, variable: v, compound: c, num: n, list } = PrologEngine;

export function buildVendingKB() {
  const e = new PrologEngine();

  // ── Product catalog (static) ────────────────────────────

  // product(Slot, Name, PriceCents)
  const products = [
    ["a1", "cola",    125],
    ["a2", "water",    75],
    ["a3", "juice",   150],
    ["b1", "chips",   100],
    ["b2", "candy",    85],
    ["b3", "cookies", 110],
  ];
  for (const [slot, name, price] of products) {
    e.addClause(c("product", [at(slot), at(name), n(price)]));
  }

  // ── Initial dynamic state ───────────────────────────────

  e.addClause(c("machine_state", [at("idle")]));
  e.addClause(c("credit", [n(0)]));

  // Sensors (initially all ok)
  for (const [name, val] of [
    ["tilt",       "ok"],
    ["door",       "closed"],
    ["temp",       "normal"],
    ["coin_mech",  "ready"],
    ["motor_a1",   "ready"], ["motor_a2",  "ready"], ["motor_a3",  "ready"],
    ["motor_b1",   "ready"], ["motor_b2",  "ready"], ["motor_b3",  "ready"],
    ["delivery",   "clear"],
    ["power",      "ok"],
  ]) {
    e.addClause(c("sensor", [at(name), at(val)]));
  }

  // Inventory
  for (const [slot, count] of [
    ["a1", 8], ["a2", 10], ["a3", 6],
    ["b1", 7], ["b2", 12], ["b3", 5],
  ]) {
    e.addClause(c("inventory", [at(slot), n(count)]));
  }

  // ── Fault detection rules ───────────────────────────────
  // These are DERIVED — they query sensor state and determine
  // if a fault condition exists.  No manual fault tracking.

  // fault_condition(tilt_detected) :- sensor(tilt, tilted).
  e.addClause(c("fault_condition", [at("tilt_detected")]),
    [c("sensor", [at("tilt"), at("tilted")])]);

  // fault_condition(door_open) :- sensor(door, open).
  e.addClause(c("fault_condition", [at("door_open")]),
    [c("sensor", [at("door"), at("open")])]);

  // fault_condition(overtemp) :- sensor(temp, hot).
  e.addClause(c("fault_condition", [at("overtemp")]),
    [c("sensor", [at("temp"), at("hot")])]);

  // fault_condition(coin_jam) :- sensor(coin_mech, jammed).
  e.addClause(c("fault_condition", [at("coin_jam")]),
    [c("sensor", [at("coin_mech"), at("jammed")])]);

  // fault_condition(power_fault) :- sensor(power, low).
  e.addClause(c("fault_condition", [at("power_fault")]),
    [c("sensor", [at("power"), at("low")])]);

  // fault_condition(delivery_blocked) :- sensor(delivery, blocked).
  e.addClause(c("fault_condition", [at("delivery_blocked")]),
    [c("sensor", [at("delivery"), at("blocked")])]);

  // motor_fault(Slot) :- sensor(MotorName, stuck), motor_for(Slot, MotorName).
  e.addClause(c("motor_fault", [v("Slot")]),
    [c("sensor", [v("M"), at("stuck")]), c("motor_for", [v("Slot"), v("M")])]);

  // motor_for(Slot, MotorName) — maps slots to motor sensors
  for (const slot of ["a1","a2","a3","b1","b2","b3"]) {
    e.addClause(c("motor_for", [at(slot), at("motor_" + slot)]));
  }

  // has_any_fault :- fault_condition(_).
  e.addClause(c("has_any_fault", []),
    [c("fault_condition", [v("_")])]);

  // has_critical_fault — faults that require immediate stop
  e.addClause(c("has_critical_fault", []),
    [c("fault_condition", [at("tilt_detected")])]);
  e.addClause(c("has_critical_fault", []),
    [c("fault_condition", [at("door_open")])]);
  e.addClause(c("has_critical_fault", []),
    [c("fault_condition", [at("power_fault")])]);

  // all_faults(Faults) :- findall(F, fault_condition(F), Faults).
  e.addClause(c("all_faults", [v("Faults")]),
    [c("findall", [v("F"), c("fault_condition", [v("F")]), v("Faults")])]);

  // ── Can-vend rules ──────────────────────────────────────
  // These determine whether a vend is allowed right now.

  // can_vend(Slot) :-
  //     machine_state(idle),
  //     not(has_any_fault),
  //     product(Slot, _, Price),
  //     credit(Credit), Credit >= Price,
  //     inventory(Slot, Count), Count > 0,
  //     not(motor_fault(Slot)),
  //     sensor(delivery, clear).
  e.addClause(c("can_vend", [v("Slot")]), [
    c("machine_state", [at("idle")]),
    c("not", [c("has_any_fault", [])]),
    c("product", [v("Slot"), v("_Name"), v("Price")]),
    c("credit", [v("Credit")]),
    c(">=" , [v("Credit"), v("Price")]),
    c("inventory", [v("Slot"), v("Count")]),
    c(">" , [v("Count"), n(0)]),
    c("not", [c("motor_fault", [v("Slot")])]),
    c("sensor", [at("delivery"), at("clear")]),
  ]);

  // vend_blocked_reason(Slot, Reason) — why can't we vend?
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("has_fault")]),
    [c("has_any_fault", [])]);
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("insufficient_credit")]),
    [c("product", [v("Slot"), v("_"), v("Price")]),
     c("credit", [v("Credit")]),
     c("<", [v("Credit"), v("Price")])]);
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("out_of_stock")]),
    [c("inventory", [v("Slot"), n(0)])]);
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("motor_stuck")]),
    [c("motor_fault", [v("Slot")])]);
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("delivery_blocked")]),
    [c("sensor", [at("delivery"), at("blocked")])]);
  e.addClause(c("vend_blocked_reason", [v("Slot"), at("not_idle")]),
    [c("machine_state", [v("S")]), c("\\=", [v("S"), at("idle")])]);

  // ── Can-accept-coin ─────────────────────────────────────

  // can_accept_coin :-
  //     machine_state(idle),
  //     not(has_critical_fault),
  //     sensor(coin_mech, ready).
  e.addClause(c("can_accept_coin", []), [
    c("machine_state", [at("idle")]),
    c("not", [c("has_critical_fault", [])]),
    c("sensor", [at("coin_mech"), at("ready")]),
  ]);

  // ── Can-return-credit ───────────────────────────────────

  // can_return_credit :- credit(C), C > 0, sensor(coin_mech, ready).
  e.addClause(c("can_return_credit", []), [
    c("credit", [v("C")]),
    c(">", [v("C"), n(0)]),
    c("sensor", [at("coin_mech"), at("ready")]),
  ]);

  // ── Actions ─────────────────────────────────────────────

  // do_insert_coin(Amount) :-
  //     can_accept_coin,
  //     credit(Old),
  //     New is Old + Amount,
  //     retract(credit(Old)),
  //     assert(credit(New)).
  e.addClause(c("do_insert_coin", [v("Amt")]), [
    c("can_accept_coin", []),
    c("credit", [v("Old")]),
    c("is", [v("New"), c("+", [v("Old"), v("Amt")])]),
    c("retract", [c("credit", [v("Old")])]),
    c("assert", [c("credit", [v("New")])]),
  ]);

  // do_select(Slot) :-
  //     can_vend(Slot),
  //     product(Slot, _, Price),
  //     credit(Old),
  //     New is Old - Price,
  //     retract(credit(Old)),
  //     assert(credit(New)),
  //     inventory(Slot, Count),
  //     NewCount is Count - 1,
  //     retract(inventory(Slot, Count)),
  //     assert(inventory(Slot, NewCount)),
  //     retract(machine_state(idle)),
  //     assert(machine_state(vending)).
  e.addClause(c("do_select", [v("Slot")]), [
    c("can_vend", [v("Slot")]),
    c("product", [v("Slot"), v("_Name"), v("Price")]),
    c("credit", [v("Old")]),
    c("is", [v("Change"), c("-", [v("Old"), v("Price")])]),
    c("retract", [c("credit", [v("Old")])]),
    c("assert", [c("credit", [v("Change")])]),
    c("inventory", [v("Slot"), v("Count")]),
    c("is", [v("NewCount"), c("-", [v("Count"), n(1)])]),
    c("retract", [c("inventory", [v("Slot"), v("Count")])]),
    c("assert", [c("inventory", [v("Slot"), v("NewCount")])]),
    c("retract", [c("machine_state", [at("idle")])]),
    c("assert", [c("machine_state", [at("vending")])]),
  ]);

  // do_vend_complete :-
  //     machine_state(vending),
  //     retract(machine_state(vending)),
  //     assert(machine_state(idle)).
  e.addClause(c("do_vend_complete", []), [
    c("machine_state", [at("vending")]),
    c("retract", [c("machine_state", [at("vending")])]),
    c("assert", [c("machine_state", [at("idle")])]),
  ]);

  // do_return_credit :-
  //     can_return_credit,
  //     credit(C),
  //     retract(credit(C)),
  //     assert(credit(0)).
  e.addClause(c("do_return_credit", []), [
    c("can_return_credit", []),
    c("credit", [v("C")]),
    c("retract", [c("credit", [v("C")])]),
    c("assert", [c("credit", [n(0)])]),
  ]);

  // ── Fault response policy ───────────────────────────────
  // What should the machine DO when it detects a fault?

  // fault_response(tilt_detected, lock_and_alarm).
  e.addClause(c("fault_response", [at("tilt_detected"), at("lock_and_alarm")]));
  e.addClause(c("fault_response", [at("door_open"), at("lock_and_alarm")]));
  e.addClause(c("fault_response", [at("power_fault"), at("emergency_return_credit")]));
  e.addClause(c("fault_response", [at("overtemp"), at("compressor_boost")]));
  e.addClause(c("fault_response", [at("coin_jam"), at("disable_coin_accept")]));
  e.addClause(c("fault_response", [at("delivery_blocked"), at("disable_vend")]));

  // should_return_credit_on_fault :-
  //     has_critical_fault, credit(C), C > 0.
  e.addClause(c("should_return_credit_on_fault", []), [
    c("has_critical_fault", []),
    c("credit", [v("C")]),
    c(">", [v("C"), n(0)]),
  ]);

  // ── Display / status queries ────────────────────────────

  // display_message(Msg) — what to show on the screen
  e.addClause(c("display_message", [at("OUT OF ORDER — TILT DETECTED")]),
    [c("fault_condition", [at("tilt_detected")])]);
  e.addClause(c("display_message", [at("SERVICE DOOR OPEN")]),
    [c("fault_condition", [at("door_open")])]);
  e.addClause(c("display_message", [at("POWER LOW — RETURNING CREDIT")]),
    [c("fault_condition", [at("power_fault")])]);
  e.addClause(c("display_message", [at("COIN MECHANISM JAMMED")]),
    [c("fault_condition", [at("coin_jam")])]);
  e.addClause(c("display_message", [at("TEMPERATURE WARNING")]),
    [c("fault_condition", [at("overtemp")])]);
  e.addClause(c("display_message", [at("PLEASE REMOVE ITEM")]),
    [c("sensor", [at("delivery"), at("blocked")])]);
  e.addClause(c("display_message", [at("VENDING...")]),
    [c("machine_state", [at("vending")])]);
  e.addClause(c("display_message", [at("INSERT COINS")]),
    [c("machine_state", [at("idle")]), c("credit", [n(0)]),
     c("not", [c("has_any_fault", [])])]);
  e.addClause(c("display_message", [at("SELECT ITEM")]),
    [c("machine_state", [at("idle")]), c("credit", [v("C")]),
     c(">", [v("C"), n(0)]),
     c("not", [c("has_any_fault", [])])]);

  // available_slots(Slots) — which slots can currently vend
  e.addClause(c("available_slots", [v("Slots")]),
    [c("findall", [v("S"), c("can_vend", [v("S")]), v("Slots")])]);

  return e;
}

// ── Helper: update a sensor value via retract/assert ──────

export function updateSensor(engine, name, value) {
  const oldQ = engine.queryFirst(
    PrologEngine.compound("sensor", [PrologEngine.atom(name), PrologEngine.variable("V")])
  );
  if (oldQ) {
    engine.retractFirst(
      PrologEngine.compound("sensor", [PrologEngine.atom(name), PrologEngine.variable("_")])
    );
  }
  engine.addClause(
    PrologEngine.compound("sensor", [PrologEngine.atom(name), PrologEngine.atom(value)])
  );
}

// ── Prolog source for display ─────────────────────────────

export const VENDING_PROLOG_SOURCE = `% ============================================
% Vending Machine Policy — Prolog
% ============================================

% --- Products ---
product(a1, cola,    125).
product(a2, water,    75).
product(b1, chips,   100).

% --- Fault detection (derived from sensors) ---
fault_condition(tilt_detected) :- sensor(tilt, tilted).
fault_condition(door_open)     :- sensor(door, open).
fault_condition(overtemp)      :- sensor(temp, hot).
fault_condition(coin_jam)      :- sensor(coin_mech, jammed).
fault_condition(power_fault)   :- sensor(power, low).

has_critical_fault :- fault_condition(tilt_detected).
has_critical_fault :- fault_condition(door_open).
has_critical_fault :- fault_condition(power_fault).

% --- Can we vend? All conditions must hold ---
can_vend(Slot) :-
    machine_state(idle),
    \\+ has_any_fault,
    product(Slot, _, Price),
    credit(Credit), Credit >= Price,
    inventory(Slot, Count), Count > 0,
    \\+ motor_fault(Slot),
    sensor(delivery, clear).

% --- Fault response policy ---
fault_response(tilt_detected, lock_and_alarm).
fault_response(door_open, lock_and_alarm).
fault_response(power_fault, emergency_return_credit).
fault_response(overtemp, compressor_boost).
fault_response(coin_jam, disable_coin_accept).

% --- Display messages (clause order = priority) ---
display_message('OUT OF ORDER') :-
    fault_condition(tilt_detected).
display_message('INSERT COINS') :-
    machine_state(idle), credit(0),
    \\+ has_any_fault.
display_message('SELECT ITEM') :-
    machine_state(idle), credit(C), C > 0,
    \\+ has_any_fault.

% --- Actions (mutate state via assert/retract) ---
do_insert_coin(Amount) :-
    can_accept_coin,
    credit(Old), New is Old + Amount,
    retract(credit(Old)),
    assert(credit(New)).

do_select(Slot) :-
    can_vend(Slot),
    product(Slot, _, Price),
    credit(Old), Change is Old - Price,
    retract(credit(Old)),
    assert(credit(Change)),
    inventory(Slot, Count),
    NewCount is Count - 1,
    retract(inventory(Slot, Count)),
    assert(inventory(Slot, NewCount)),
    retract(machine_state(idle)),
    assert(machine_state(vending)).`;
