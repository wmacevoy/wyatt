# ============================================================
# fossilize.py — Freeze a Prolog engine's clause database
#
# After fossilize(), the engine is uncorruptable:
#   - assert/1, retract/1, retractall/1 → fail (no solutions)
#   - addClause → no-op
#   - ephemeral/1 still works (scoped, auto-retracted)
#   - queries still work (rules + facts are readable)
#
# The engine becomes a pure decision function:
#   events in (ephemeral) → decisions out (send/2)
#   No Prolog injection can modify the knowledge base.
#
# Usage:
#   from fossilize import fossilize
#   engine = Engine()
#   # ... load rules, facts, initial state ...
#   fossilize(engine)
# ============================================================

from prolog import unify


def fossilize(engine):
    """Freeze the clause database.  Only ephemeral facts allowed after this.

    Returns the fossil boundary (clause count at freeze time).
    """
    boundary = len(engine.clauses)

    # ── Disable permanent mutation builtins (goal fails) ─────
    def _fail(*args):
        pass  # no solutions produced — goal fails in Prolog

    engine.builtins["assert/1"] = _fail
    engine.builtins["assertz/1"] = _fail
    engine.builtins["retract/1"] = _fail
    engine.builtins["retractall/1"] = _fail

    # ── Disable programmatic additions ───────────────────────
    engine.add_clause = lambda head, body=None: None

    # ── retract_first: ephemeral zone only (>= boundary) ────
    def _fossil_retract_first(head):
        for i in range(boundary, len(engine.clauses)):
            ch, cb = engine.clauses[i]
            s = unify(head, ch, {})
            if s is not None:
                engine.clauses.pop(i)
                if not cb:
                    for fn in engine.on_retract:
                        fn(ch)
                return True
        return False

    engine.retract_first = _fossil_retract_first

    return boundary
