// ============================================================
// reactive-prolog.js — Reactive queries over a Prolog engine
// Portable: same constraints as reactive.js
// ============================================================

import { createSignal, createMemo, createEffect } from "./reactive.js";

function createReactiveEngine(engineOrFactory) {
  var engine = typeof engineOrFactory === "function"
    ? engineOrFactory() : engineOrFactory;

  var pair = createSignal(0);
  var generation = pair[0];
  var setGeneration = pair[1];

  function bump() {
    setGeneration(function(g) { return g + 1; });
  }

  function act(goal) {
    var result = engine.queryFirst(goal);
    bump();
    return result;
  }

  function _createQuery(goalFn, limit) {
    return createMemo(function() {
      generation();
      return engine.query(goalFn(), limit || 50);
    });
  }

  function _createQueryFirst(goalFn) {
    return createMemo(function() {
      generation();
      return engine.queryFirst(goalFn());
    });
  }

  function onUpdate(fn) {
    createEffect(function() {
      generation();
      fn();
    });
  }

  // ephemeral/1 — scoped assertion: assert term, solve rest, retract term.
  // The term is visible to subsequent goals in the clause body, then
  // automatically retracted (even if the query exits early via queryFirst).
  engine.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    engine.clauses.push({ head: term, body: [] });
    try {
      engine.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      engine.retractFirst(term);
    }
  };

  return {
    engine: engine,
    generation: generation,
    bump: bump,
    act: act,
    createQuery: _createQuery,
    createQueryFirst: _createQueryFirst,
    onUpdate: onUpdate
  };
}

if (typeof exports !== "undefined") {
  exports.createReactiveEngine = createReactiveEngine;
}
export { createReactiveEngine };
