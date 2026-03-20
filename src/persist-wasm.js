// ============================================================
// persist-wasm.js — Bridge between SQLCipher WASM and persist
//
// Loads SQLCipher WASM, creates a DB (oo1-compatible), returns
// an object that qsqlAdapter/persist can use directly.
//
// Usage (browser):
//   var db = await createWasmDb("sqlcipher.wasm");
//   persist(engine, qsqlAdapter(db));
//
// Usage (encrypted):
//   var db = await createWasmDb("sqlcipher.wasm", "secret");
//
// The returned db matches the sqlite3 oo1 API:
//   db.exec(sql), db.prepare(sql), db.selectObjects(sql),
//   db.transaction(fn), db.close()
//
// This file uses async/await — it runs in the browser or Node 18+,
// NOT in QuickJS/Duktape (they don't have WASM).
// ============================================================

async function createWasmDb(wasmUrl, encryptionKey) {
  // Load the Emscripten module
  // initSqlcipher (encrypted) or initSqlite (plain) from the WASM build
  var Module, init;
  if (typeof initSqlcipher === "function") init = initSqlcipher;
  else if (typeof initSqlite === "function") init = initSqlite;
  else throw new Error("initSqlcipher/initSqlite not found — load the WASM JS first");

  Module = await init({
    locateFile: function() { return wasmUrl || "sqlcipher.wasm"; }
  });

  // DB is appended to the WASM glue by shim.js
  if (typeof DB !== "function") {
    throw new Error("DB not found — load shim.js after the WASM JS");
  }

  var opts = {filename: ":memory:"};
  if (encryptionKey) opts.key = encryptionKey;

  var db = new DB(Module, opts);

  // better-sqlite3 compat shim for persist adapters that use
  // db.prepare(sql).run(...) / db.prepare(sql).all(...)
  var _origPrepare = db.prepare;
  db.prepare = function(sql) {
    var stmt = _origPrepare.call(db, sql);
    // Add better-sqlite3-style .run() and .all()
    stmt.run = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) stmt.bind(args);
      while (stmt.step()) {}
      stmt.reset();
    };
    stmt.all = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) stmt.bind(args);
      var rows = [];
      while (stmt.step()) rows.push(stmt.get({}));
      stmt.reset();
      return rows;
    };
    return stmt;
  };

  return db;
}

// ── Export ───────────────────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.createWasmDb = createWasmDb;
}
if (typeof window !== "undefined") {
  window.createWasmDb = createWasmDb;
}
