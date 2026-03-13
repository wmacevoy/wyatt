// ============================================================
// node.js — MeshNode: Prolog engine + reactive layer + transport
//
// Incoming signals pass through Prolog ephemeral/react rules.
// If accepted, the react rule upserts facts; otherwise dropped.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { buildMeshKB } from "./mesh-kb.js";

const { atom, variable, compound, num } = PrologEngine;

export class MeshNode {
  /**
   * @param {object} options
   * @param {string} options.id — unique node identifier
   * @param {object} options.transport — SimTransport or NNG transport
   */
  constructor(options) {
    this.id = options.id;
    this.transport = options.transport;
    this._signalLog = [];

    // Build engine with mesh KB
    const engine = buildMeshKB(PrologEngine, this.id);

    // Wrap in reactive layer (registers ephemeral/1 builtin)
    const reactive = createReactiveEngine(engine);

    // Create sync engine (bumps reactive generation on fact changes)
    const sync = new SyncEngine(engine, { onSync: reactive.bump });

    this.engine = engine;
    this.reactive = reactive;
    this.sync = sync;

    // Wire transport receive → signal policy
    const self = this;
    this.transport.onReceive(function(fromAddress, payload) {
      self._handleSignal(fromAddress, payload);
    });
  }

  // ── Signal handling ─────────────────────────────────────

  _handleSignal(fromAddress, payload) {
    if (!payload || payload.kind !== "signal") return;

    const fact = deserialize(payload.fact);
    if (!fact) return;

    const result = this.engine.queryWithSends(
      compound("handle_signal", [atom(fromAddress), fact])
    );

    this._signalLog.push({
      from: fromAddress,
      fact: fact,
      accepted: result.result !== null
    });

    if (result.result) {
      for (var i = 0; i < result.sends.length; i++) {
        var s = result.sends[i];
        this.transport.send(s.target.name, {
          kind: "signal",
          from: this.id,
          fact: serialize(s.fact)
        });
      }
      this.reactive.bump();
    }
  }

  // ── Sending ─────────────────────────────────────────────

  /** Send a fact to a specific node. */
  send(toNodeId, fact) {
    this.transport.send(toNodeId, {
      kind: "signal",
      from: this.id,
      fact: serialize(fact)
    });
  }

  /** Broadcast a fact to all peers. */
  broadcast(fact) {
    this.transport.broadcast({
      kind: "signal",
      from: this.id,
      fact: serialize(fact)
    });
  }

  // ── Local state ─────────────────────────────────────────

  /** Assert a fact locally (bypasses policy — for own state). */
  assertLocal(fact) {
    this.sync.assertFact(fact);
  }

  /** Retract a fact locally. */
  retractLocal(fact) {
    this.sync.retractFact(fact);
  }

  // ── Queries ─────────────────────────────────────────────

  query(goal, limit) {
    return this.engine.query(goal, limit);
  }

  queryFirst(goal) {
    return this.engine.queryFirst(goal);
  }

  // ── Cleanup ─────────────────────────────────────────────

  close() {
    this.transport.close();
  }
}
