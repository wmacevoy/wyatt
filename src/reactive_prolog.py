# ============================================================
# reactive_prolog.py — Reactive queries over a Prolog engine
#
# The bridge: sensor signals bump a generation counter,
# dependent memos (queries) recompute, effects drive actuators.
#
# Auto-bump: engine.on_assert / on_retract set a dirty flag.
# After any query that mutated facts, generation bumps once.
# No manual bump() needed (but still available).
# ============================================================

from reactive import signal, memo, effect


class ReactiveEngine:
    """Wrap a prolog.Engine with reactive query capabilities."""

    def __init__(self, engine):
        self.engine = engine
        self._gen_read, self._gen_write = signal(0)
        self._dirty = False

        # Track mutations via engine callbacks
        _self = self
        engine.on_assert.append(lambda head: _set_dirty(_self))
        engine.on_retract.append(lambda head: _set_dirty(_self))

        # Wrap engine query methods: auto-bump after mutating queries
        _orig_q = engine.query
        _orig_qf = engine.query_first
        _orig_qws = engine.query_with_sends

        def _wrap_query(goal, limit=50):
            _self._dirty = False
            result = _orig_q(goal, limit)
            if _self._dirty:
                _self._dirty = False
                _self.bump()
            return result

        def _wrap_query_first(goal):
            _self._dirty = False
            result = _orig_qf(goal)
            if _self._dirty:
                _self._dirty = False
                _self.bump()
            return result

        def _wrap_query_with_sends(goal):
            _self._dirty = False
            result = _orig_qws(goal)
            if _self._dirty:
                _self._dirty = False
                _self.bump()
            return result

        engine.query = _wrap_query
        engine.query_first = _wrap_query_first
        engine.query_with_sends = _wrap_query_with_sends

    def generation(self):
        return self._gen_read()

    def bump(self):
        """Signal that the clause database has changed."""
        self._gen_write(lambda g: g + 1)

    def act(self, goal):
        """Run a goal (may assert/retract) and bump.
        With auto-bump, this is equivalent to engine.query_first(goal)."""
        return self.engine.query_first(goal)

    def query(self, goal_fn, limit=50):
        """Reactive query — recomputes when generation changes."""
        eng = self.engine
        gen = self._gen_read
        def compute():
            gen()  # track dependency
            return eng.query(goal_fn(), limit)
        return memo(compute)

    def query_first(self, goal_fn):
        """Reactive query_first — recomputes when generation changes."""
        eng = self.engine
        gen = self._gen_read
        def compute():
            gen()  # track dependency
            return eng.query_first(goal_fn())
        return memo(compute)

    def on_update(self, fn):
        """Register a side-effect that runs on every mutation."""
        gen = self._gen_read
        def wrapped():
            gen()  # track dependency
            fn()
        effect(wrapped)


def _set_dirty(rp):
    rp._dirty = True
