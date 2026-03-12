// ============================================================
// reactive.js — Signal/memo/effect runtime
//
// Portable: no let/const, no arrows, no for-of, no Set,
// no .bind(), no template literals, no destructuring.
// Works in: Node, Bun, Deno, QuickJS, Duktape, Hermes,
// all browsers, V8/JSC/SpiderMonkey shell.
// ============================================================

var _currentObserver = null;
var _batchDepth = 0;
var _pendingEffects = [];

function createSignal(initialValue) {
  var value = initialValue;
  var subscribers = [];

  function read() {
    if (_currentObserver) {
      var found = false;
      for (var i = 0; i < subscribers.length; i++) {
        if (subscribers[i] === _currentObserver) { found = true; break; }
      }
      if (!found) subscribers.push(_currentObserver);
    }
    return value;
  }

  function write(nextValue) {
    if (typeof nextValue === "function") {
      value = nextValue(value);
    } else {
      value = nextValue;
    }
    var toRun = subscribers.slice();
    if (_batchDepth > 0) {
      for (var i = 0; i < toRun.length; i++) _pendingEffects.push(toRun[i]);
    } else {
      for (var i = 0; i < toRun.length; i++) toRun[i]._run();
    }
  }

  return [read, write];
}

function _Computation(fn) {
  this._fn = fn;
  this.value = undefined;
  this.dirty = true;
}

_Computation.prototype._run = function() {
  var prev = _currentObserver;
  _currentObserver = this;
  try {
    this.value = this._fn();
    this.dirty = false;
  } finally {
    _currentObserver = prev;
  }
  return this.value;
};

function createMemo(fn) {
  var comp = new _Computation(fn);
  comp._run();
  var origRun = comp._run;
  comp._run = function() {
    comp.dirty = true;
    return origRun.call(comp);
  };
  return function() {
    if (comp.dirty) comp._run();
    return comp.value;
  };
}

function createEffect(fn) {
  var comp = new _Computation(fn);
  comp._run();
}

function batch(fn) {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) {
      var effects = _pendingEffects.slice();
      _pendingEffects = [];
      var seen = [];
      for (var i = 0; i < effects.length; i++) {
        var dup = false;
        for (var j = 0; j < seen.length; j++) {
          if (seen[j] === effects[i]) { dup = true; break; }
        }
        if (!dup) { seen.push(effects[i]); effects[i]._run(); }
      }
    }
  }
}

if (typeof exports !== "undefined") {
  exports.createSignal = createSignal;
  exports.createMemo = createMemo;
  exports.createEffect = createEffect;
  exports.batch = batch;
}
export { createSignal, createMemo, createEffect, batch };
