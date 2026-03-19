// ============================================================
// dashboard/server.js — Greenhouse coordinator + web dashboard
//
// Combines a Prolog engine with ephemeral/react signal policy,
// a UDP listener for mesh signals, and an HTTP server with SSE.
//
// Env vars:
//   LISTEN_PORT  — UDP port to bind (default 9500)
//   HTTP_PORT    — HTTP server port (default 3000)
//   GATEWAY_ADDR — host:port for the gateway node (default gateway:9500)
// ============================================================

import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrologEngine, listToArray } from "../../../src/prolog-engine.js";
import { loadString } from "../../../src/loader.js";
import { serialize, deserialize } from "../../../src/sync.js";

var atom     = PrologEngine.atom;
var variable = PrologEngine.variable;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;

// ── Configuration ─────────────────────────────────────────────

var LISTEN_PORT  = parseInt(process.env.LISTEN_PORT  || "9500", 10);
var HTTP_PORT    = parseInt(process.env.HTTP_PORT     || "3000", 10);
var GATEWAY_ADDR = process.env.GATEWAY_ADDR || "gateway:9500";

function parseAddr(addr) {
  var idx = addr.lastIndexOf(":");
  if (idx === -1) {
    return { host: addr, port: 9500 };
  }
  return {
    host: addr.substring(0, idx),
    port: parseInt(addr.substring(idx + 1), 10)
  };
}

var gateway = parseAddr(GATEWAY_ADDR);

// ── Resolve __dirname for serving static files ────────────────

var __filename = fileURLToPath(import.meta.url);
var __dirname  = dirname(__filename);

// ── Prolog engine setup ───────────────────────────────────────

var engine = new PrologEngine();

var RULES = [
  "threshold(temperature, 5, 40).",
  "threshold(humidity, 20, 85).",
  "threshold(vpd, 40, 160).",
  "",
  "react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-",
  "    node_role(coordinator),",
  "    node_status(From, online),",
  "    retractall(reading(From, Type, _OldA, _OldB)),",
  "    assert(reading(From, Type, Val, Ts)),",
  "    check_alerts(From, Type).",
  "check_alerts(Node, Type) :- alert(Node, Type, Level),",
  "    send(gateway, alert_notice(Node, Type, Level)).",
  "check_alerts(_AnyNode, _AnyType).",
  "react({type: signal, from: estimator, fact: estimate(Type, Node, Val, Confidence, Ts)}) :-",
  "    node_role(coordinator),",
  "    retractall(estimate(Type, Node, _OldA, _OldB, _OldC)),",
  "    assert(estimate(Type, Node, Val, Confidence, Ts)),",
  "    send(gateway, estimate(Type, Node, Val, Confidence, Ts)).",
  "react({type: signal, from: From, fact: node_status(From, Status)}) :-",
  "    node_role(coordinator),",
  "    retractall(node_status(From, _OldS)),",
  "    assert(node_status(From, Status)).",
  "",
  "alert(Node, temperature, high) :-",
  "    reading(Node, temperature, Val, _Ts),",
  "    threshold(temperature, _Min, Max), Val > Max.",
  "alert(Node, temperature, low) :-",
  "    reading(Node, temperature, Val, _Ts),",
  "    threshold(temperature, Min, _Max), Val < Min.",
  "alert(Node, humidity, high) :-",
  "    reading(Node, humidity, Val, _Ts),",
  "    threshold(humidity, _Min, Max), Val > Max.",
  "alert(Node, humidity, low) :-",
  "    reading(Node, humidity, Val, _Ts),",
  "    threshold(humidity, Min, _Max), Val < Min.",
  "alert(Node, vpd, high) :-",
  "    estimate(vpd, Node, Val, _Confidence, _Ts),",
  "    threshold(vpd, _Min, Max), Val > Max.",
  "alert(Node, vpd, low) :-",
  "    estimate(vpd, Node, Val, _Confidence, _Ts),",
  "    threshold(vpd, Min, _Max), Val < Min.",
  "",
  "all_alerts(Alerts) :- findall(alert(N,T,L), alert(N,T,L), Alerts).",
  "online_nodes(Nodes) :- findall(N, node_status(N, online), Nodes).",
  "mesh_status(critical) :- alert(_A, _B, _C).",
  "mesh_status(normal) :- not(alert(_A, _B, _C)).",
  "",
  "update_threshold(Type, Min, Max) :-",
  "    retractall(threshold(Type, _OldA, _OldB)),",
  "    assert(threshold(Type, Min, Max)),",
  "    send(gateway, threshold(Type, Min, Max))."
].join("\n");

loadString(engine, RULES);

engine.addClause(compound("node_role", [atom("coordinator")]));
engine.addClause(compound("node_id",   [atom("coordinator")]));

// ── SSE client management ─────────────────────────────────────

var sseClients = new Set();

function notifyClients() {
  var data = JSON.stringify(getState());
  var payload = "data: " + data + "\n\n";
  for (var client of sseClients) {
    try {
      client.controller.enqueue(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// ── State extraction ──────────────────────────────────────────

function getState() {
  var statusResult = engine.queryFirst(compound("mesh_status", [variable("S")]));
  var status = statusResult ? statusResult.args[0].name : "unknown";

  var nodesResult = engine.queryFirst(compound("online_nodes", [variable("N")]));
  var onlineNodes = [];
  if (nodesResult) {
    var nodeList = listToArray(nodesResult.args[0]);
    for (var i = 0; i < nodeList.length; i++) {
      onlineNodes.push(nodeList[i].name);
    }
  }

  var readingResults = engine.query(
    compound("reading", [variable("N"), variable("T"), variable("V"), variable("Ts")]),
    100
  );
  var readings = [];
  for (var i = 0; i < readingResults.length; i++) {
    var r = readingResults[i];
    readings.push({
      node:  r.args[0].name,
      type:  r.args[1].name,
      value: r.args[2].value,
      ts:    r.args[3].value
    });
  }

  var alertResults = engine.queryFirst(compound("all_alerts", [variable("A")]));
  var alerts = [];
  if (alertResults) {
    var alertList = listToArray(alertResults.args[0]);
    for (var i = 0; i < alertList.length; i++) {
      var a = alertList[i];
      alerts.push({
        node:  a.args[0].name,
        type:  a.args[1].name,
        level: a.args[2].name
      });
    }
  }

  var estimateResults = engine.query(
    compound("estimate", [variable("T"), variable("N"), variable("V"), variable("C"), variable("Ts")]),
    100
  );
  var estimates = [];
  for (var i = 0; i < estimateResults.length; i++) {
    var e = estimateResults[i];
    estimates.push({
      type:       e.args[0].name,
      node:       e.args[1].name,
      value:      e.args[2].value,
      confidence: e.args[3].value,
      ts:         e.args[4].value
    });
  }

  var thresholdTypes = ["temperature", "humidity", "vpd"];
  var thresholds = {};
  for (var i = 0; i < thresholdTypes.length; i++) {
    var tType = thresholdTypes[i];
    var tResult = engine.queryFirst(
      compound("threshold", [atom(tType), variable("Min"), variable("Max")])
    );
    if (tResult) {
      thresholds[tType] = {
        min: tResult.args[1].value,
        max: tResult.args[2].value
      };
    }
  }

  return {
    status:      status,
    onlineNodes: onlineNodes,
    readings:    readings,
    alerts:      alerts,
    estimates:   estimates,
    thresholds:  thresholds
  };
}

// ── Signal handling ───────────────────────────────────────────

function handleSignal(from, fact) {
  // Track whether react rules mutated the DB (= signal accepted)
  var mutated = false;
  var markDirty = function() { mutated = true; };
  engine.onAssert.push(markDirty);
  engine.onRetract.push(markDirty);

  // Fire ephemeral with QJSON object event, collect sends
  engine._sends = [];
  engine.queryFirst(compound("ephemeral", [
    PrologEngine.object([
      { key: "type", value: atom("signal") },
      { key: "from", value: atom(from) },
      { key: "fact", value: fact }
    ])
  ]));
  var sends = engine._sends.slice();
  engine._sends = [];

  // Remove temporary mutation tracker
  engine.onAssert.pop();
  engine.onRetract.pop();

  if (!mutated) {
    console.log("[dashboard] dropped signal from " + from +
                " (" + (fact.functor || fact.name || "?") + ")");
    return;
  }

  console.log("[dashboard] accepted " + (fact.functor || fact.name) + " from " + from);

  // Dispatch all sends from Prolog react rules
  for (var i = 0; i < sends.length; i++) {
    var s = sends[i];
    var targetName = s.target.name;
    if (targetName === "gateway") {
      sendToGateway(s.fact);
    } else {
      sendToNode(targetName + ":9500", s.fact);
    }
  }

  notifyClients();
}

// ── Send a fact to the gateway ────────────────────────────────

function sendToGateway(fact) {
  var payload = JSON.stringify({
    kind: "signal",
    from: "coordinator",
    fact: serialize(fact)
  });
  var buf = Buffer.from(payload);
  udpSock.send(buf, 0, buf.length, gateway.port, gateway.host, function(err) {
    if (err) {
      console.error("[dashboard] failed to send to gateway:", err.message);
    }
  });
}

// ── Send a fact to a sensor ───────────────────────────────────

function sendToNode(nodeAddr, fact) {
  var target = parseAddr(nodeAddr);
  var payload = JSON.stringify({
    kind: "signal",
    from: "coordinator",
    fact: serialize(fact)
  });
  var buf = Buffer.from(payload);
  udpSock.send(buf, 0, buf.length, target.port, target.host, function(err) {
    if (err) {
      console.error("[dashboard] failed to send to " + nodeAddr + ":", err.message);
    }
  });
}

// ── UDP transport ─────────────────────────────────────────────

var udpSock = dgram.createSocket("udp4");

udpSock.on("error", function(err) {
  console.error("[dashboard] socket error:", err.message);
  udpSock.close();
});

udpSock.on("message", function(msg, rinfo) {
  var payload;
  try {
    payload = JSON.parse(msg.toString());
  } catch (e) {
    console.error("[dashboard] bad JSON from " + rinfo.address + ":" + rinfo.port);
    return;
  }

  if (!payload || payload.kind !== "signal") return;

  var fromId = payload.from;
  var fact   = deserialize(payload.fact);
  if (!fact || !fromId) return;

  handleSignal(fromId, fact);
});

udpSock.bind(LISTEN_PORT, function() {
  console.log("[dashboard] UDP listening on port " + LISTEN_PORT);
  console.log("[dashboard] gateway at " + gateway.host + ":" + gateway.port);
});

// ── HTTP server (Bun.serve) ───────────────────────────────────

var indexHtml = readFileSync(join(__dirname, "index.html"), "utf-8");

Bun.serve({
  port: HTTP_PORT,

  fetch: function(req) {
    var url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return new Response(JSON.stringify(getState()), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      var client = { controller: null };

      var stream = new ReadableStream({
        start: function(controller) {
          client.controller = controller;
          sseClients.add(client);
          var initial = "data: " + JSON.stringify(getState()) + "\n\n";
          controller.enqueue(initial);
        },
        cancel: function() {
          sseClients.delete(client);
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive"
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/threshold") {
      return req.json().then(function(body) {
        var type = body.type;
        var min  = body.min;
        var max  = body.max;

        if (!type || min === undefined || max === undefined) {
          return new Response(JSON.stringify({ error: "missing type, min, or max" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Upsert threshold and send to gateway via Prolog rule
        var result = engine.queryWithSends(
          compound("update_threshold", [atom(type), num(min), num(max)])
        );

        console.log("[dashboard] threshold updated: " + type +
                    " min=" + min + " max=" + max);

        // Dispatch sends from update_threshold rule
        for (var i = 0; i < result.sends.length; i++) {
          var s = result.sends[i];
          var targetName = s.target.name;
          if (targetName === "gateway") {
            sendToGateway(s.fact);
          } else {
            sendToNode(targetName + ":9500", s.fact);
          }
        }

        notifyClients();

        return new Response(JSON.stringify(getState()), {
          headers: { "Content-Type": "application/json" }
        });
      });
    }

    return new Response("Not Found", { status: 404 });
  }
});

console.log("[dashboard] HTTP server on port " + HTTP_PORT);
console.log("[dashboard] Endpoints: GET /, /api/state, /api/events  POST /api/threshold");
