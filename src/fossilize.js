// ============================================================
// fossilize.js — Freeze a Prolog engine's clause database
//
// After fossilize(), the engine is uncorruptable:
//   - assert/1, retract/1, retractall/1 → fail (no solutions)
//   - addClause → no-op
//   - ephemeral/1 still works (scoped, auto-retracted)
//   - queries still work (rules + facts are readable)
//
// The engine becomes a pure decision function:
//   events in (ephemeral) → decisions out (send/2)
//   No Prolog injection can modify the knowledge base.
//
// Portable: ES5, no dependencies.
//
// Usage:
//   fossilize(engine);
// ============================================================

function fossilize(engine) {
  var boundary = engine.clauses.length;

  // ── Disable permanent mutation builtins (goal fails) ─────
  function _fail() {}  // no solutions — goal fails in Prolog

  engine.builtins["assert/1"] = _fail;
  engine.builtins["assertz/1"] = _fail;
  engine.builtins["retract/1"] = _fail;
  engine.builtins["retractall/1"] = _fail;

  // ── Disable programmatic additions ───────────────────────
  engine.addClause = function() {};

  // ── retractFirst: ephemeral zone only (>= boundary) ──────
  engine.retractFirst = function(head) {
    for (var i = boundary; i < engine.clauses.length; i++) {
      var ch = engine.clauses[i].head;
      var cb = engine.clauses[i].body;
      if (engine.unify(head, ch, new Map()) !== null) {
        engine.clauses.splice(i, 1);
        if (cb.length === 0) {
          for (var j = 0; j < engine.onRetract.length; j++)
            engine.onRetract[j](ch);
        }
        return true;
      }
    }
    return false;
  };

  return boundary;
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.fossilize = fossilize;
}
export { fossilize };
