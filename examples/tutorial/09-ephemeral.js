// ============================================================
// 09-ephemeral.js — Ephemeral/react signal handling + send/2
//
// ephemeral/1 is a scoped assertion: it asserts a fact, solves
// the remaining goals, then auto-retracts the fact.  Combined
// with user-defined `react` rules, this gives a clean pattern
// for accepting or dropping external signals.
//
// send/2 captures outgoing messages during react rules, so the
// complete response (what to store AND what to send) is
// expressed declaratively in Prolog.
//
// Run:  node examples/tutorial/09-ephemeral.js
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";

var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var atom     = PrologEngine.atom;
var num      = PrologEngine.num;

var e = new PrologEngine();

// createReactiveEngine registers ephemeral/1 as a builtin
var rp = createReactiveEngine(e);

loadString(e, [
  // Trusted sensors
  "trusted_sensor(sensor_1).",
  "trusted_sensor(sensor_2).",
  "",
  // Entry point: temporarily assert signal(From, Fact), then try react rules.
  // If no react rule matches, the signal is dropped (query returns null).
  "handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.",
  "",
  // React rules: pattern-match on the ephemeral signal, upsert permanent facts.
  // signal(From, temperature(From, Room, Val)) — From must match (spoofing protection)
  // send/2 captures outgoing messages to be dispatched by the host.
  "react :- signal(From, temperature(From, Room, Val)),",
  "         trusted_sensor(From),",
  "         retractall(temperature(Room, _)),",
  "         assert(temperature(Room, Val)),",
  "         send(dashboard, temperature(Room, Val)).",
  "",
  // Accept humidity readings the same way
  "react :- signal(From, humidity(From, Room, Val)),",
  "         trusted_sensor(From),",
  "         retractall(humidity(Room, _)),",
  "         assert(humidity(Room, Val)),",
  "         send(dashboard, humidity(Room, Val)).",
  "",
  // Derived rules
  "cold(Room) :- temperature(Room, T), T < 65.",
  "status(alert) :- cold(_).",
  "status(normal) :- not(cold(_))."
].join("\n"));

// ── Process signals ──────────────────────────────────────────

// queryWithSends returns { result, sends, output }
// result: the query result (null if dropped)
// sends: array of { target, fact } from send/2 calls

// Trusted sensor sends a temperature reading
var r1 = e.queryWithSends(compound("handle_signal", [
  atom("sensor_1"),
  compound("temperature", [atom("sensor_1"), atom("kitchen"), num(72)])
]));
// r1.result is non-null → accepted
// r1.sends has one entry: send(dashboard, temperature(kitchen, 72))

// Untrusted sensor is rejected (not in trusted_sensor/1)
var r2 = e.queryWithSends(compound("handle_signal", [
  atom("rogue"),
  compound("temperature", [atom("rogue"), atom("kitchen"), num(999)])
]));
// r2.result is null → dropped, r2.sends is empty

// Spoofed sender is rejected (From doesn't match signal sender)
var r3 = e.queryWithSends(compound("handle_signal", [
  atom("sensor_1"),
  compound("temperature", [atom("sensor_2"), atom("kitchen"), num(999)])
]));
// r3.result is null → dropped

// After processing, the signal fact is gone (ephemeral auto-retracted)
var staleSignal = e.queryFirst(compound("signal", [variable("_"), variable("_")]));
// null — ephemeral cleaned up

// But the permanent fact was asserted by the react rule
var kitchenTemp = e.queryFirst(compound("temperature", [atom("kitchen"), variable("T")]));

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Signal from sensor_1: " + (r1.result !== null ? "accepted" : "dropped"));
_print("  sends: " + r1.sends.length + " (target=" + (r1.sends.length > 0 ? r1.sends[0].target.name : "none") + ")");
_print("Signal from rogue: " + (r2.result !== null ? "accepted" : "dropped"));
_print("  sends: " + r2.sends.length);
_print("Spoofed signal: " + (r3.result !== null ? "accepted" : "dropped"));
_print("Stale signal in DB: " + (staleSignal !== null));
_print("Kitchen temp: " + kitchenTemp.args[1].value);
