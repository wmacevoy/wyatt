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
