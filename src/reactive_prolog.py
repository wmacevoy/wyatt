# ============================================================
# reactive_prolog.py — Reactive queries over a Prolog engine
#
# The bridge: sensor signals bump a generation counter,
# dependent memos (queries) recompute, effects drive actuators.
# ============================================================

from reactive import signal, memo, effect


class ReactiveEngine:
    """Wrap a prolog.Engine with reactive query capabilities."""

    def __init__(self, engine):
        self.engine = engine
        self._gen_read, self._gen_write = signal(0)

    def generation(self):
        return self._gen_read()

    def bump(self):
        """Signal that the clause database has changed."""
        self._gen_write(lambda g: g + 1)

    def act(self, goal):
        """Run a goal (may assert/retract) and bump."""
        result = self.engine.query_first(goal)
        self.bump()
        return result

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
