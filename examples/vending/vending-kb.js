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
import { loadString } from "../../src/loader.js";

export function buildVendingKB() {
  const e = new PrologEngine();

  loadString(e, `
% ── Product catalog (static) ────────────────────────────
% product(Slot, Name, PriceCents)
product(a1, cola,    125).
product(a2, water,    75).
product(a3, juice,   150).
product(b1, chips,   100).
product(b2, candy,    85).
product(b3, cookies, 110).

% ── Initial dynamic state ───────────────────────────────
machine_state(idle).
credit(0).

% Sensors (initially all ok)
sensor(tilt,      ok).
sensor(door,      closed).
sensor(temp,      normal).
sensor(coin_mech, ready).
sensor(motor_a1,  ready).
sensor(motor_a2,  ready).
sensor(motor_a3,  ready).
sensor(motor_b1,  ready).
sensor(motor_b2,  ready).
sensor(motor_b3,  ready).
sensor(delivery,  clear).
sensor(power,     ok).

% Inventory
inventory(a1, 8).
inventory(a2, 10).
inventory(a3, 6).
inventory(b1, 7).
inventory(b2, 12).
inventory(b3, 5).

% ── Fault detection rules ───────────────────────────────
fault_condition(tilt_detected) :- sensor(tilt, tilted).
fault_condition(door_open)     :- sensor(door, open).
fault_condition(overtemp)      :- sensor(temp, hot).
fault_condition(coin_jam)      :- sensor(coin_mech, jammed).
fault_condition(power_fault)   :- sensor(power, low).
fault_condition(delivery_blocked) :- sensor(delivery, blocked).

motor_fault(Slot) :- sensor(M, stuck), motor_for(Slot, M).

motor_for(a1, motor_a1).
motor_for(a2, motor_a2).
motor_for(a3, motor_a3).
motor_for(b1, motor_b1).
motor_for(b2, motor_b2).
motor_for(b3, motor_b3).

has_any_fault :- fault_condition(_).

has_critical_fault :- fault_condition(tilt_detected).
has_critical_fault :- fault_condition(door_open).
has_critical_fault :- fault_condition(power_fault).

all_faults(Faults) :- findall(F, fault_condition(F), Faults).

% ── Can-vend rules ──────────────────────────────────────
can_vend(Slot) :-
    machine_state(idle),
    not(has_any_fault),
    product(Slot, _Name, Price),
    credit(Credit), Credit >= Price,
    inventory(Slot, Count), Count > 0,
    not(motor_fault(Slot)),
    sensor(delivery, clear).

% vend_blocked_reason(Slot, Reason)
vend_blocked_reason(Slot, has_fault)           :- has_any_fault.
vend_blocked_reason(Slot, insufficient_credit) :- product(Slot, _, Price), credit(Credit), Credit < Price.
vend_blocked_reason(Slot, out_of_stock)        :- inventory(Slot, 0).
vend_blocked_reason(Slot, motor_stuck)         :- motor_fault(Slot).
vend_blocked_reason(Slot, delivery_blocked)    :- sensor(delivery, blocked).
vend_blocked_reason(Slot, not_idle)            :- machine_state(S), S \\= idle.

% ── Can-accept-coin ─────────────────────────────────────
can_accept_coin :-
    machine_state(idle),
    not(has_critical_fault),
    sensor(coin_mech, ready).

% ── Can-return-credit ───────────────────────────────────
can_return_credit :- credit(C), C > 0, sensor(coin_mech, ready).

% ── Actions ─────────────────────────────────────────────
do_insert_coin(Amt) :-
    can_accept_coin,
    credit(Old),
    New is Old + Amt,
    retract(credit(Old)),
    assert(credit(New)).

do_select(Slot) :-
    can_vend(Slot),
    product(Slot, _Name, Price),
    credit(Old),
    Change is Old - Price,
    retract(credit(Old)),
    assert(credit(Change)),
    inventory(Slot, Count),
    NewCount is Count - 1,
    retract(inventory(Slot, Count)),
    assert(inventory(Slot, NewCount)),
    retract(machine_state(idle)),
    assert(machine_state(vending)).

do_vend_complete :-
    machine_state(vending),
    retract(machine_state(vending)),
    assert(machine_state(idle)).

do_return_credit :-
    can_return_credit,
    credit(C),
    retract(credit(C)),
    assert(credit(0)).

% ── Fault response policy ───────────────────────────────
fault_response(tilt_detected, lock_and_alarm).
fault_response(door_open, lock_and_alarm).
fault_response(power_fault, emergency_return_credit).
fault_response(overtemp, compressor_boost).
fault_response(coin_jam, disable_coin_accept).
fault_response(delivery_blocked, disable_vend).

should_return_credit_on_fault :-
    has_critical_fault, credit(C), C > 0.

% ── Display / status queries ────────────────────────────
display_message('OUT OF ORDER \u2014 TILT DETECTED') :- fault_condition(tilt_detected).
display_message('SERVICE DOOR OPEN')                  :- fault_condition(door_open).
display_message('POWER LOW \u2014 RETURNING CREDIT')   :- fault_condition(power_fault).
display_message('COIN MECHANISM JAMMED')              :- fault_condition(coin_jam).
display_message('TEMPERATURE WARNING')                :- fault_condition(overtemp).
display_message('PLEASE REMOVE ITEM')                 :- sensor(delivery, blocked).
display_message('VENDING...')                         :- machine_state(vending).
display_message('INSERT COINS')                       :- machine_state(idle), credit(0), not(has_any_fault).
display_message('SELECT ITEM')                        :- machine_state(idle), credit(C), C > 0, not(has_any_fault).

% ── Available slots ─────────────────────────────────────
available_slots(Slots) :- findall(S, can_vend(S), Slots).
  `);

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
