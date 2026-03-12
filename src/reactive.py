# ============================================================
# reactive.py — Signal/memo/effect runtime
#
# Portable: CPython 3.6+, PyPy, MicroPython 1.19+.
# No dependencies. No set() (uses list for max compatibility).
# No f-strings, no walrus, no dataclasses.
# ============================================================

_observer = None
_batch_depth = 0
_pending = []


def signal(initial):
    state = [initial]
    subs = []

    def read():
        global _observer
        if _observer is not None:
            found = False
            for s in subs:
                if s is _observer:
                    found = True
                    break
            if not found:
                subs.append(_observer)
        return state[0]

    def write(val):
        global _batch_depth, _pending
        if callable(val):
            state[0] = val(state[0])
        else:
            state[0] = val
        to_run = list(subs)
        if _batch_depth > 0:
            _pending.extend(to_run)
        else:
            for s in to_run:
                s._run()

    return read, write


class _Computation:
    def __init__(self, fn):
        self.fn = fn
        self.value = None
        self.dirty = True

    def _run(self):
        global _observer
        prev = _observer
        _observer = self
        try:
            self.value = self.fn()
            self.dirty = False
        finally:
            _observer = prev
        return self.value


def memo(fn):
    comp = _Computation(fn)
    comp._run()
    orig_run = comp._run

    def trigger_run():
        comp.dirty = True
        return orig_run()
    comp._run = trigger_run

    def getter():
        if comp.dirty:
            comp._run()
        return comp.value
    return getter


def effect(fn):
    comp = _Computation(fn)
    comp._run()


def batch(fn):
    global _batch_depth, _pending
    _batch_depth += 1
    try:
        fn()
    finally:
        _batch_depth -= 1
        if _batch_depth == 0:
            effects = list(_pending)
            _pending = []
            seen = []
            for e in effects:
                dup = False
                for s in seen:
                    if s is e:
                        dup = True
                        break
                if not dup:
                    seen.append(e)
                    e._run()
