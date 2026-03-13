// ============================================================
// Margin Trading Knowledge Base
//
// Triggered margin buy/sell with precise decimal arithmetic.
// Designed for QuickJS --bignum (BigDecimal) but falls back
// to Number on any other JS runtime.
//
// Dynamic state (via assert/retract):
//   account_balance(V)        — cash balance (decimal string)
//   position(Symbol,Qty,Entry)— open position
//   price(Symbol,V)           — current market price
//   margin_requirement(Pct)   — maintenance margin % (e.g. "25")
//
// Derived (rules):
//   position_value/3, unrealized_pnl/3, total_equity/1,
//   margin_used/1, margin_ratio/1, margin_status/1,
//   trigger/3 — fires buy/sell/liquidate/take_profit/stop_loss
//
// Custom builtins (registered on engine):
//   bd_is(Result, Expr)       — BigDecimal arithmetic
//   bd_gt(A, B), bd_lt(A, B), bd_gte(A, B), bd_lte(A, B)
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";

var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;

// ── BigDecimal / Number adapter ──────────────────────────────

var _hasBD = false;
try { _hasBD = (typeof BigDecimal !== "undefined"); } catch(e) {}

function _toBD(s) {
  if (_hasBD) return BigDecimal(s);
  return Number(s);
}

function _bdStr(x) {
  return String(x);
}

function _bdEval(term) {
  if (!term) return null;
  if (term.type === "atom") {
    var v = _toBD(term.name);
    if (_hasBD) return v;
    if (isNaN(v)) return null;
    return v;
  }
  if (term.type === "num") return _toBD(String(term.value));
  if (term.type === "compound") {
    var f = term.functor, a = term.args;
    if (f === "+" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x + y : null;
    }
    if (f === "-" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x - y : null;
    }
    if (f === "*" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x * y : null;
    }
    if (f === "/" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      if (x === null || y === null) return null;
      if (_hasBD) return BigDecimal.div(x, y, { maximumFractionDigits: 8, roundingMode: "half-even" });
      return y !== 0 ? x / y : null;
    }
    if (f === "-" && a.length === 1) {
      var x = _bdEval(a[0]);
      return x !== null ? -x : null;
    }
    if (f === "abs" && a.length === 1) {
      var x = _bdEval(a[0]);
      if (x === null) return null;
      return x < _toBD("0") ? -x : x;
    }
  }
  return null;
}

// ── Register BigDecimal builtins on engine ────────────────────

function registerBDBuiltins(engine) {
  var self = engine;

  // bd_is(Result, Expr) — evaluate Expr with BigDecimal, unify as atom
  self.builtins["bd_is/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var lhs = goal.args[0];
    var rhs = self.deepWalk(goal.args[1], subst);
    var val = _bdEval(rhs);
    if (val !== null) {
      var s = self.unify(lhs, at(_bdStr(val)), subst);
      if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
    }
  };

  // comparison builtins
  var bdComps = [
    ["bd_gt/2",  function(a,b) { return a > b; }],
    ["bd_lt/2",  function(a,b) { return a < b; }],
    ["bd_gte/2", function(a,b) { return a >= b; }],
    ["bd_lte/2", function(a,b) { return a <= b; }]
  ];
  for (var i = 0; i < bdComps.length; i++) {
    (function(op, fn) {
      self.builtins[op] = function(goal, rest, subst, counter, depth, onSolution) {
        var a = _bdEval(self.deepWalk(goal.args[0], subst));
        var b = _bdEval(self.deepWalk(goal.args[1], subst));
        if (a !== null && b !== null && fn(a, b))
          self.solve(rest, subst, counter, depth + 1, onSolution);
      };
    })(bdComps[i][0], bdComps[i][1]);
  }

  // bd_sum_list builtin — sums a Prolog list of decimal-atom values
  self.builtins["bd_sum_list/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var list = self.deepWalk(goal.args[0], subst);
    var out = goal.args[1];
    var sum = _toBD("0");
    while (list && list.type === "compound" && list.functor === "." && list.args.length === 2) {
      var item = self.deepWalk(list.args[0], subst);
      var val = _bdEval(item);
      if (val !== null) sum = sum + val;
      list = self.deepWalk(list.args[1], subst);
    }
    var s = self.unify(out, at(_bdStr(sum)), subst);
    if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
  };
}

// ── Prolog text for facts and rules ──────────────────────────

var marginProgram = [
  "% ── Initial account state ──────────────────────────────",
  "account_balance('100000.00').",
  "margin_requirement('25').",
  "",
  "% ── Sample positions ───────────────────────────────────",
  "position('BTC', '2.5', '29500.00').",
  "position('ETH', '50', '1850.00').",
  "",
  "% ── Initial prices ─────────────────────────────────────",
  "price('BTC', '30000.00').",
  "price('ETH', '1900.00').",
  "",
  "% ── Triggers (static config) ───────────────────────────",
  "trigger_config('BTC', take_profit, '35000.00').",
  "trigger_config('BTC', stop_loss, '27000.00').",
  "trigger_config('ETH', take_profit, '2200.00').",
  "trigger_config('ETH', stop_loss, '1600.00').",
  "",
  "% ── Derived: position_value(Symbol, Qty, Value) ────────",
  "position_value(Sym, Qty, Val) :-",
  "  position(Sym, Qty, _Entry),",
  "  price(Sym, Price),",
  "  bd_is(Val, Qty * Price).",
  "",
  "% ── Derived: unrealized_pnl(Symbol, Qty, PnL) ─────────",
  "unrealized_pnl(Sym, Qty, PnL) :-",
  "  position(Sym, Qty, Entry),",
  "  price(Sym, Price),",
  "  bd_is(Diff, Price - Entry),",
  "  bd_is(PnL, Qty * Diff).",
  "",
  "% ── Derived: total_positions_value(V) ──────────────────",
  "total_positions_value(Total) :-",
  "  findall(V, position_value(_S, _Q, V), Vals),",
  "  bd_sum_list(Vals, Total).",
  "",
  "% ── Derived: total_pnl(PnL) ───────────────────────────",
  "total_pnl(Total) :-",
  "  findall(P, unrealized_pnl(_S, _Q, P), PnLs),",
  "  bd_sum_list(PnLs, Total).",
  "",
  "% ── Derived: total_equity(E) ───────────────────────────",
  "total_equity(Eq) :-",
  "  account_balance(Bal),",
  "  total_pnl(PnL),",
  "  bd_is(Eq, Bal + PnL).",
  "",
  "% ── Derived: margin_used(M) ────────────────────────────",
  "margin_used(M) :-",
  "  total_positions_value(TV),",
  "  margin_requirement(Pct),",
  "  bd_is(Raw, TV * Pct),",
  "  bd_is(M, Raw / '100').",
  "",
  "% ── Derived: margin_ratio(R) ───────────────────────────",
  "margin_ratio(R) :-",
  "  total_equity(Eq),",
  "  margin_used(M),",
  "  bd_gt(M, '0'),",
  "  bd_is(Raw, Eq * '100'),",
  "  bd_is(R, Raw / M).",
  "",
  "% ── Derived: margin_status(Status) ─────────────────────",
  "margin_status(liquidation) :-",
  "  margin_ratio(R),",
  "  bd_lt(R, '50').",
  "margin_status(margin_call) :-",
  "  margin_ratio(R),",
  "  bd_gte(R, '50'),",
  "  bd_lt(R, '100').",
  "margin_status(warning) :-",
  "  margin_ratio(R),",
  "  bd_gte(R, '100'),",
  "  bd_lt(R, '150').",
  "margin_status(healthy) :-",
  "  margin_ratio(R),",
  "  bd_gte(R, '150').",
  "",
  "% ── Triggers: trigger(Symbol, Type, Action) ────────────",
  "trigger(Sym, take_profit, sell) :-",
  "  trigger_config(Sym, take_profit, Thresh),",
  "  price(Sym, Price),",
  "  bd_gte(Price, Thresh).",
  "trigger(Sym, stop_loss, sell) :-",
  "  trigger_config(Sym, stop_loss, Thresh),",
  "  price(Sym, Price),",
  "  bd_lte(Price, Thresh).",
  "trigger(Sym, margin_call, reduce_position) :-",
  "  margin_status(margin_call),",
  "  position(Sym, _Q, _E).",
  "trigger(Sym, liquidation, liquidate) :-",
  "  margin_status(liquidation),",
  "  position(Sym, _Q, _E).",
  "",
  "% ── All active triggers ────────────────────────────────",
  "active_triggers(Ts) :-",
  "  findall(t(S, Ty, A), trigger(S, Ty, A), Ts).",
  "",
  "% ── Display status ─────────────────────────────────────",
  "display_status('LIQUIDATION WARNING') :- margin_status(liquidation).",
  "display_status('MARGIN CALL') :- margin_status(margin_call).",
  "display_status('LOW MARGIN WARNING') :- margin_status(warning).",
  "display_status('OK') :- margin_status(healthy)."
].join("\n");

// ── Build the knowledge base ─────────────────────────────────

function buildMarginKB() {
  var e = new PrologEngine();
  registerBDBuiltins(e);
  loadString(e, marginProgram);
  return e;
}

// ── Helpers ──────────────────────────────────────────────────

function updatePrice(engine, symbol, price) {
  engine.retractFirst(c("price", [at(symbol), v("_")]));
  engine.addClause(c("price", [at(symbol), at(price)]));
}

function updateBalance(engine, balance) {
  engine.retractFirst(c("account_balance", [v("_")]));
  engine.addClause(c("account_balance", [at(balance)]));
}

function addPosition(engine, symbol, qty, entry) {
  engine.addClause(c("position", [at(symbol), at(qty), at(entry)]));
}

function removePosition(engine, symbol) {
  engine.retractFirst(c("position", [at(symbol), v("_Q"), v("_E")]));
}

function addTrigger(engine, symbol, type, threshold) {
  engine.addClause(c("trigger_config", [at(symbol), at(type), at(threshold)]));
}

function removeTrigger(engine, symbol, type) {
  engine.retractFirst(c("trigger_config", [at(symbol), at(type), v("_")]));
}

if (typeof exports !== "undefined") {
  exports.buildMarginKB = buildMarginKB;
  exports.updatePrice = updatePrice;
  exports.updateBalance = updateBalance;
  exports.addPosition = addPosition;
  exports.removePosition = removePosition;
  exports.addTrigger = addTrigger;
  exports.removeTrigger = removeTrigger;
  exports.registerBDBuiltins = registerBDBuiltins;
}
export {
  buildMarginKB, updatePrice, updateBalance,
  addPosition, removePosition,
  addTrigger, removeTrigger, registerBDBuiltins
};
