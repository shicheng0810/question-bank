const It = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1e3,
  maxArrayItems: 5e3,
  maxStringUtf8Bytes: 1048576,
  maxCanonicalUtf8Bytes: 3145728,
  maxMutationUtf8Bytes: 16384,
  maxPushMutations: 100,
  maxPushUtf8Bytes: 262144,
  maxPushResponseUtf8Bytes: 65536,
  maxPullChanges: 200,
  maxPullUtf8Bytes: 524288,
  maxContentChunkBytes: 524288,
  maxPrivateBankUtf8Bytes: 3145728,
  maxPrivateBankQuestions: 5e3,
  maxPrivateBanks: 15
}), Ht = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1e3,
  maxArrayItems: 1e5,
  maxStringUtf8Bytes: 100 * 1024 * 1024,
  maxCanonicalUtf8Bytes: 100 * 1024 * 1024
}), Xt = Object.freeze(["sourceKey", "legacyRevision", "legacyId"]), Tt = new TextEncoder(), Wt = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
class Yt extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(n, o, s) {
    super(s), this.name = "AppDataValidationError", this.code = n, this.path = o;
  }
}
function m(e, n, o) {
  throw new Yt(e, n, o);
}
function pt(e) {
  return typeof e != "string" && m("type", "$", "UTF-8 length requires a string"), Tt.encode(e).byteLength;
}
function et(e, n, o) {
  const s = pt(e);
  return s > o.maxStringUtf8Bytes && m("utf8_limit", n, "string exceeds the configured UTF-8 limit"), s;
}
function Zt(e) {
  if (e === "0") return !0;
  if (!/^[1-9][0-9]*$/.test(e)) return !1;
  const n = Number(e);
  return Number.isSafeInteger(n) && n < 4294967295 && String(n) === e;
}
function tt(e) {
  let n = 2;
  for (let o = 0; o < e.length; o += 1) {
    const s = e.charCodeAt(o);
    if (s === 34 || s === 92 || s === 8 || s === 9 || s === 10 || s === 12 || s === 13) {
      n += 2;
      continue;
    }
    if (s < 32) {
      n += 6;
      continue;
    }
    if (s >= 55296 && s <= 56319) {
      const u = o + 1 < e.length ? e.charCodeAt(o + 1) : 0;
      if (u >= 56320 && u <= 57343) {
        n += 4, o += 1;
        continue;
      }
      n += 6;
      continue;
    }
    if (s >= 56320 && s <= 57343) {
      n += 6;
      continue;
    }
    s <= 127 ? n += 1 : s <= 2047 ? n += 2 : n += 3;
  }
  return n;
}
class en {
  constructor() {
    this.parts = [], this.bytes = 0;
  }
  /** @param {string} part @param {string} path @param {CanonicalLimits} limits */
  append(n, o, s) {
    const u = pt(n);
    u > s.maxCanonicalUtf8Bytes - this.bytes && m("utf8_limit", o, "canonical JSON exceeds the total AppData bound"), this.parts.push(n), this.bytes += u;
  }
  /** @returns {Uint8Array} */
  finish() {
    return Tt.encode(this.parts.join(""));
  }
}
function De(e, n, o, s, u, d) {
  if (o > d.maxDepth && m("depth_limit", n, "value exceeds configured nesting depth"), e === null) {
    u.append("null", n, d);
    return;
  }
  if (typeof e == "boolean") {
    u.append(e ? "true" : "false", n, d);
    return;
  }
  if (typeof e == "string") {
    et(e, n, d), tt(e) > d.maxCanonicalUtf8Bytes - u.bytes && m("utf8_limit", n, "canonical JSON exceeds the total AppData bound"), u.append(JSON.stringify(e), n, d);
    return;
  }
  if (typeof e == "number") {
    Number.isFinite(e) || m("finite_number", n, "must be a finite number"), u.append(JSON.stringify(Object.is(e, -0) ? 0 : e), n, d);
    return;
  }
  if ((typeof e != "object" || e === null) && m("type", n, "value is not JSON data"), s.has(e) && m("cycle", n, "cyclic values are not JSON data"), s.add(e), Array.isArray(e)) {
    Object.getPrototypeOf(e) !== Array.prototype && m("prototype", n, "array must use Array.prototype");
    const E = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(e)
    ), g = E.length;
    (!g || !Object.hasOwn(g, "value") || typeof g.value != "number") && m("descriptor", n, "array length must be a data property");
    const y = g.value;
    (!Number.isSafeInteger(y) || y > d.maxArrayItems) && m("array_limit", n, "array exceeds configured item limit");
    for (const A of Reflect.ownKeys(E)) {
      if (A === "length") continue;
      (typeof A != "string" || !Zt(A) || Number(A) >= y) && m("array_property", n, "arrays may not have non-index properties");
      const I = E[A];
      (!I || !Object.hasOwn(I, "value") || !I.enumerable) && m("accessor", `${n}[${A}]`, "array elements must be enumerable data properties");
    }
    u.append("[", n, d);
    for (let A = 0; A < y; A += 1) {
      A > 0 && u.append(",", n, d);
      const I = String(A), S = E[I];
      S || m("array_hole", `${n}[${A}]`, "array holes are not JSON"), De(S.value, `${n}[${A}]`, o + 1, s, u, d);
    }
    u.append("]", n, d);
  } else {
    Object.getPrototypeOf(e) !== Object.prototype && m("prototype", n, "object must use Object.prototype");
    const E = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(e)
    ), g = Reflect.ownKeys(E);
    g.length > d.maxObjectKeys && m("object_limit", n, "object exceeds configured key limit");
    const y = [];
    for (const A of g) {
      typeof A != "string" && m("symbol", n, "symbol keys are not JSON"), Wt.has(A) && m("prototype_pollution", `${n}.${A}`, "prototype-pollution key is forbidden");
      const I = E[A];
      (!I || !Object.hasOwn(I, "value")) && m("accessor", `${n}.${A}`, "accessors are not JSON"), I.enumerable || m("non_enumerable", `${n}.${A}`, "non-enumerable fields cannot be silently omitted"), et(A, `${n}.${A}`, d), y.push(A);
    }
    y.sort(), u.append("{", n, d);
    for (let A = 0; A < y.length; A += 1) {
      const I = y[A];
      typeof I != "string" && m("descriptor", n, "object key must be a string"), A > 0 && u.append(",", n, d);
      const S = E[I];
      (!S || !Object.hasOwn(S, "value")) && m("accessor", `${n}.${I}`, "accessors are not JSON");
      const _ = tt(I), F = d.maxCanonicalUtf8Bytes - u.bytes;
      _ + 1 > F && m("utf8_limit", `${n}.${I}`, "canonical JSON exceeds the total AppData bound"), u.append(`${JSON.stringify(I)}:`, `${n}.${I}`, d), De(S.value, `${n}.${I}`, o + 1, s, u, d);
    }
    u.append("}", n, d);
  }
  s.delete(e);
}
function de(e) {
  const n = new en();
  return De(e, "$", 0, /* @__PURE__ */ new WeakSet(), n, It), n.finish();
}
const Oe = (e, n) => n.some((o) => e instanceof o);
let nt, rt;
function tn() {
  return nt || (nt = [
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction
  ]);
}
function nn() {
  return rt || (rt = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}
const xe = /* @__PURE__ */ new WeakMap(), Se = /* @__PURE__ */ new WeakMap(), le = /* @__PURE__ */ new WeakMap();
function rn(e) {
  const n = new Promise((o, s) => {
    const u = () => {
      e.removeEventListener("success", d), e.removeEventListener("error", E);
    }, d = () => {
      o(v(e.result)), u();
    }, E = () => {
      s(e.error), u();
    };
    e.addEventListener("success", d), e.addEventListener("error", E);
  });
  return le.set(n, e), n;
}
function on(e) {
  if (xe.has(e))
    return;
  const n = new Promise((o, s) => {
    const u = () => {
      e.removeEventListener("complete", d), e.removeEventListener("error", E), e.removeEventListener("abort", E);
    }, d = () => {
      o(), u();
    }, E = () => {
      s(e.error || new DOMException("AbortError", "AbortError")), u();
    };
    e.addEventListener("complete", d), e.addEventListener("error", E), e.addEventListener("abort", E);
  });
  xe.set(e, n);
}
let Ue = {
  get(e, n, o) {
    if (e instanceof IDBTransaction) {
      if (n === "done")
        return xe.get(e);
      if (n === "store")
        return o.objectStoreNames[1] ? void 0 : o.objectStore(o.objectStoreNames[0]);
    }
    return v(e[n]);
  },
  set(e, n, o) {
    return e[n] = o, !0;
  },
  has(e, n) {
    return e instanceof IDBTransaction && (n === "done" || n === "store") ? !0 : n in e;
  }
};
function gt(e) {
  Ue = e(Ue);
}
function sn(e) {
  return nn().includes(e) ? function(...n) {
    return e.apply(Re(this), n), v(this.request);
  } : function(...n) {
    return v(e.apply(Re(this), n));
  };
}
function an(e) {
  return typeof e == "function" ? sn(e) : (e instanceof IDBTransaction && on(e), Oe(e, tn()) ? new Proxy(e, Ue) : e);
}
function v(e) {
  if (e instanceof IDBRequest)
    return rn(e);
  if (Se.has(e))
    return Se.get(e);
  const n = an(e);
  return n !== e && (Se.set(e, n), le.set(n, e)), n;
}
const Re = (e) => le.get(e);
function cn(e, n, { blocked: o, upgrade: s, blocking: u, terminated: d } = {}) {
  const E = indexedDB.open(e, n), g = v(E);
  return s && E.addEventListener("upgradeneeded", (y) => {
    s(v(E.result), y.oldVersion, y.newVersion, v(E.transaction), y);
  }), o && E.addEventListener("blocked", (y) => o(
    // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
    y.oldVersion,
    y.newVersion,
    y
  )), g.then((y) => {
    d && y.addEventListener("close", () => d()), u && y.addEventListener("versionchange", (A) => u(A.oldVersion, A.newVersion, A));
  }).catch(() => {
  }), g;
}
const un = ["get", "getKey", "getAll", "getAllKeys", "count"], fn = ["put", "add", "delete", "clear"], Le = /* @__PURE__ */ new Map();
function ot(e, n) {
  if (!(e instanceof IDBDatabase && !(n in e) && typeof n == "string"))
    return;
  if (Le.get(n))
    return Le.get(n);
  const o = n.replace(/FromIndex$/, ""), s = n !== o, u = fn.includes(o);
  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(o in (s ? IDBIndex : IDBObjectStore).prototype) || !(u || un.includes(o))
  )
    return;
  const d = async function(E, ...g) {
    const y = this.transaction(E, u ? "readwrite" : "readonly");
    let A = y.store;
    return s && (A = A.index(g.shift())), (await Promise.all([
      A[o](...g),
      u && y.done
    ]))[0];
  };
  return Le.set(n, d), d;
}
gt((e) => ({
  ...e,
  get: (n, o, s) => ot(n, o) || e.get(n, o, s),
  has: (n, o) => !!ot(n, o) || e.has(n, o)
}));
const dn = ["continue", "continuePrimaryKey", "advance"], st = {}, ke = /* @__PURE__ */ new WeakMap(), _t = /* @__PURE__ */ new WeakMap(), ln = {
  get(e, n) {
    if (!dn.includes(n))
      return e[n];
    let o = st[n];
    return o || (o = st[n] = function(...s) {
      ke.set(this, _t.get(this)[n](...s));
    }), o;
  }
};
async function* An(...e) {
  let n = this;
  if (n instanceof IDBCursor || (n = await n.openCursor(...e)), !n)
    return;
  n = n;
  const o = new Proxy(n, ln);
  for (_t.set(o, n), le.set(o, Re(n)); n; )
    yield o, n = await (ke.get(o) || n.continue()), ke.delete(o);
}
function it(e, n) {
  return n === Symbol.asyncIterator && Oe(e, [IDBIndex, IDBObjectStore, IDBCursor]) || n === "iterate" && Oe(e, [IDBIndex, IDBObjectStore]);
}
gt((e) => ({
  ...e,
  get(n, o, s) {
    return it(n, o) ? An : e.get(n, o, s);
  },
  has(n, o) {
    return it(n, o) || e.has(n, o);
  }
}));
const hn = 100 * 1024 * 1024, yn = 200, En = 128 * 1024;
Object.freeze({ maxContentBytes: hn, maxChunks: yn, maxManifestBytes: En, maxChunkBytes: It.maxContentChunkBytes, maxContentCanonicalBytes: Ht.maxCanonicalUtf8Bytes });
const p = (e, n, o = !1) => ({ name: e, keyPath: n, unique: o });
function mt(e) {
  if (e && typeof e == "object" && !Object.isFrozen(e)) {
    Object.freeze(e);
    for (const n of Reflect.ownKeys(e)) mt(e[n]);
  }
  return e;
}
mt({
  meta: { keyPath: "key", indexes: [] },
  bank_revisions: { keyPath: ["bankUid", "revision"], indexes: [p("bankUid", "bankUid")] },
  content_chunks: { keyPath: ["contentDigest", "chunkIndex"], indexes: [p("contentDigest", "contentDigest")] },
  question_aliases: { keyPath: Xt, indexes: [p("sourceKey", "sourceKey"), p("mappingStatus", "mappingStatus"), p("newQuestionKey", "newQuestionKey")] },
  attempts: { keyPath: "attemptId", indexes: [p("status", "status"), p("startedAt", "startedAt")] },
  attempt_scope: { keyPath: ["attemptId", "ordinal"], indexes: [p("attemptId", "attemptId")] },
  drafts: { keyPath: ["attemptId", "questionKey"], indexes: [p("attemptId", "attemptId")] },
  answer_events: { keyPath: "eventId", indexes: [p("attemptId", "attemptId"), p("questionKey", "questionKey"), p("attemptAction", ["attemptId", "writerStreamId", "actionSeq"], !0)] },
  user_state: { keyPath: ["questionKey", "field"], indexes: [p("starredKey", "starredKey"), p("serverRevision", "serverRevision")] },
  mutations: { keyPath: "mutationId", indexes: [p("streamSequence", ["clientStreamId", "clientSeq"], !0)] },
  outbox: { keyPath: "mutationId", indexes: [p("nextAttemptAt", "nextAttemptAt")] },
  conflicts: { keyPath: "conflictId", indexes: [p("entityKey", "entityKey"), p("status", "status")] },
  legacy_raw: { keyPath: ["sourceId", "sourceDigest", "chunkIndex"], indexes: [p("sourceId", "sourceId")] },
  legacy_aggregates: { keyPath: ["sourceId", "namespace", "legacyQuestionId"], indexes: [p("mappingStatus", "mappingStatus")] },
  migration_journal: { keyPath: "migrationId", indexes: [p("status", "status")] },
  import_receipts: { keyPath: ["sourceId", "sourceRecordId"], indexes: [] },
  checkpoints: { keyPath: "checkpointId", indexes: [p("createdAt", "createdAt")] },
  entity_tombstones: { keyPath: "entityKey", indexes: [p("entityKind", "entityKind"), p("accountGeneration", "accountGeneration")] },
  writer_leases: { keyPath: "attemptId", indexes: [p("expiresAt", "expiresAt")] }
});
function wn(e, n, o) {
  const s = new Error(n);
  return s.name = "StorageError", s.code = e, s;
}
const Pe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, St = Object.prototype.hasOwnProperty;
function $(e, n, o) {
  return wn(e, n);
}
function In(e, n) {
  if (e === null || typeof e != "object" || Array.isArray(e) || Object.getPrototypeOf(e) !== Object.prototype || Object.getOwnPropertySymbols(e).length)
    throw $("CORRUPT", `${n} must be a plain data record`);
  for (const o of Object.getOwnPropertyNames(e)) {
    const s = Object.getOwnPropertyDescriptor(e, o);
    if (!s || !St.call(s, "value")) throw $("CORRUPT", `${n}.${o} must be a data property`);
  }
  return (
    /** @type {Record<string, unknown>} */
    e
  );
}
function at(e, n, o, s) {
  const u = /* @__PURE__ */ new Set([...n, ...o]);
  if (Object.keys(e).some((d) => !u.has(d)) || n.some((d) => !St.call(e, d)))
    throw $("CORRUPT", `${s} has an unsupported shape`);
}
function Tn(e) {
  const n = In(e, "owner");
  if (n.ownerKind === "guest") {
    if (at(n, ["ownerKind", "guestId"], [], "owner"), !Pe.test(
      /** @type {string} */
      n.guestId
    )) throw $("INVALID", "guestId must be a UUIDv4");
    return Object.freeze({ ownerKind: "guest", guestId: (
      /** @type {string} */
      n.guestId
    ) });
  }
  if (n.ownerKind === "account") {
    if (at(n, ["ownerKind", "accountId", "accountGeneration"], [], "owner"), typeof n.accountId != "string" || n.accountId.length === 0 || new TextEncoder().encode(n.accountId).byteLength > 512 || !Pe.test(
      /** @type {string} */
      n.accountGeneration
    ))
      throw $("INVALID", "account owner must have a bounded accountId and accountGeneration");
    return Object.freeze({ ownerKind: "account", accountId: n.accountId, accountGeneration: n.accountGeneration });
  }
  throw $("INVALID", "ownerKind must be guest or account");
}
function pn(e) {
  const n = typeof e == "string" && e.startsWith("qb-v2-business-") ? "qb-v2-business-" : "qb-b1a-test-business-";
  if (typeof e != "string" || !e.startsWith(n) || !Pe.test(e.slice(n.length))) throw $("CORRUPT", "business dbName is not a generated profile name");
  return e;
}
const q = "completedDeletes", Lt = 100, k = (e) => Object.assign(new Error(e), { code: e }), fe = (e, n) => e && typeof e == "object" && !Array.isArray(e) && Object.keys(e).sort().join() === n.slice().sort().join();
function Ae(e) {
  if (de(e), e === null) return null;
  if (!fe(e, ["accountId", "accountGeneration"]) || !/^[0-9a-f]{64}$/.test(e.accountId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.accountGeneration)) throw k("INVALID_CLEANUP_RECEIPT");
  return { ...e };
}
const Ce = (e) => JSON.stringify(e && [e.accountId, e.accountGeneration]);
function Be(e) {
  if (e === void 0) return { key: q, version: 1, entries: [] };
  if (de(e), !fe(e, ["key", "version", "entries"]) || e.key !== q || e.version !== 1 || !Array.isArray(e.entries) || e.entries.length > Lt) throw k("INVALID_CLEANUP_RECEIPT");
  const n = /* @__PURE__ */ new Set(), o = e.entries.map((s) => {
    if (!fe(s, ["owner", "status"]) || s.status !== "server-complete") throw k("INVALID_CLEANUP_RECEIPT");
    const u = Ae(s.owner), d = Ce(u);
    if (n.has(d)) throw k("INVALID_CLEANUP_RECEIPT");
    return n.add(d), { owner: u, status: "server-complete" };
  });
  return { key: q, version: 1, entries: o };
}
function Nt(e, n, o = !1) {
  const s = Be(e), u = Ae(n), d = Ce(u), E = s.entries.filter((g) => Ce(g.owner) !== d);
  if (o || E.push({ owner: u, status: "server-complete" }), E.length > Lt) throw k("LOCAL_CLEANUP_QUEUE_FULL");
  return { ...s, entries: E };
}
function gn(e) {
  if (e?.state !== "cleanup_pending") return;
  if (de(e), !fe(e, ["key", "owner", "controlId", "state", "cleanupDbs"])) throw k("INVALID_CLEANUP_RECEIPT");
  const n = Tn(e.owner);
  if (n.ownerKind !== "account") throw k("INVALID_CLEANUP_RECEIPT");
  const o = Ae({ accountId: n.accountId, accountGeneration: n.accountGeneration });
  if (e.key !== JSON.stringify(["account", o.accountId, o.accountGeneration]) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.controlId) || !Array.isArray(e.cleanupDbs) || e.cleanupDbs.length > 1e3 || new Set(e.cleanupDbs).size !== e.cleanupDbs.length) throw k("INVALID_CLEANUP_RECEIPT");
  for (const s of e.cleanupDbs) pn(s);
  return o;
}
async function je() {
  let e = !1, n;
  const o = cn("qb-v2-profile-directory", 1, { upgrade(u, d, E, g) {
    if (e || d !== 0) {
      g.abort();
      return;
    }
    u.createObjectStore("owners", { keyPath: "key" }), u.createObjectStore("meta", { keyPath: "key" });
  } });
  o.then((u) => {
    e && u.close();
  }, () => {
  });
  let s;
  try {
    s = await Promise.race([o, new Promise((u, d) => {
      n = setTimeout(() => {
        e = !0, d(k("STORAGE_UNAVAILABLE"));
      }, 5e3);
    })]);
  } finally {
    clearTimeout(n);
  }
  try {
    if (s.version !== 1 || s.objectStoreNames.length !== 2 || !s.objectStoreNames.contains("owners") || !s.objectStoreNames.contains("meta")) throw k("SCHEMA_MISMATCH");
    const u = s.transaction(["owners", "meta"]);
    for (const d of ["owners", "meta"]) {
      const E = u.objectStore(d);
      if (E.keyPath !== "key" || E.autoIncrement || E.indexNames.length)
        throw u.abort(), await u.done.catch(() => {
        }), k("SCHEMA_MISMATCH");
    }
    return await u.done, s.onversionchange = () => s.close(), s;
  } catch (u) {
    throw s.close(), u;
  }
}
async function ct() {
  const e = await je();
  try {
    return Be(await e.get("meta", q)).entries;
  } finally {
    e.close();
  }
}
async function _n() {
  const e = await je();
  try {
    const n = e.transaction(["owners", "meta"], "readwrite");
    try {
      let o = Be(await n.objectStore("meta").get(q)), s = await n.objectStore("owners").openCursor();
      for (; s; ) {
        const u = gn(s.value);
        u && (o = Nt(o, u)), s = await s.continue();
      }
      await n.objectStore("meta").put(o), await n.done;
    } catch (o) {
      try {
        n.abort();
      } catch {
      }
      throw await n.done.catch(() => {
      }), o;
    }
  } finally {
    e.close();
  }
}
async function bt(e, n) {
  const o = Ae(e), s = await je();
  try {
    const u = s.transaction("meta", "readwrite");
    try {
      const d = Nt(await u.store.get(q), o, n);
      await u.store.put(d), await u.done;
    } catch (d) {
      try {
        u.abort();
      } catch {
      }
      throw await u.done.catch(() => {
      }), d;
    }
  } finally {
    s.close();
  }
}
const ut = (e) => bt(e, !1), ft = (e) => bt(e, !0), mn = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/, Sn = /* @__PURE__ */ new Set(["history", "banks", "verify"]);
class Ln extends Error {
  constructor(n, o = null) {
    super(n), this.name = "LegacyMigrationError", this.code = n, this.details = o;
  }
}
function ae(e, n) {
  throw new Ln(e, n);
}
function Nn(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function dt(e) {
  return Number.isSafeInteger(e) && e >= 0;
}
function bn(e, n) {
  if (e === 202 && n.error === "MIGRATION_PENDING") {
    (Object.hasOwn(n, "token") || n.ok !== !1 || !Nn(n.migration)) && ae("INVALID_RESPONSE");
    const s = n.migration;
    return (s.status !== "running" || !Sn.has(s.phase) || !dt(s.processed) || !dt(s.total) || s.processed > s.total || !Number.isSafeInteger(n.retryAfterMs) || n.retryAfterMs !== 750) && ae("INVALID_RESPONSE"), { state: "pending", migration: structuredClone(s), retryAfterMs: n.retryAfterMs };
  }
  if (e === 200 && n.ok === !0 && typeof n.token == "string" && mn.test(n.token))
    return { state: "ready", token: n.token };
  (/* @__PURE__ */ new Set(["MIGRATION_UNCERTAIN", "MIGRATION_QUARANTINED", "ACCOUNT_DELETED", "UNAVAILABLE", "RATE_LIMITED", "AUTH_FAILED"])).has(n.error) && ae(n.error, { retryable: n.error === "UNAVAILABLE" || n.error === "RATE_LIMITED" }), ae("AUTH_FAILED");
}
const Ne = "qb_account_v2_session_v1", ce = "qb_account_v2_delete_ticket_v1", J = "qb_account_v2_local_cleanup_v1", ue = 2, Dn = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/, Dt = /^[0-9a-f]{64}$/, On = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, Ot = On, lt = /^dt1\.[0-9a-f]{64}\.[0-9a-f]{64}$/, At = 8, be = 32, ht = 3500, xn = 3e4, Un = 3600;
class xt extends Error {
  constructor(n) {
    super(n), this.name = "AccountV2Error", this.code = n;
  }
}
function i(e) {
  return new xt(e);
}
function U(e, n) {
  if (!e || typeof e != "object" || Array.isArray(e)) return !1;
  const o = Object.keys(e);
  return o.length === n.length && n.every((s) => o.includes(s));
}
function Rn(e) {
  return U(e, ["ok", "accountId", "accountGeneration", "expiresAt"]) && e.ok === !0 && Dt.test(e.accountId) && Ot.test(e.accountGeneration) && Number.isSafeInteger(e.expiresAt) && e.expiresAt > Date.now();
}
function yt(e) {
  return typeof e == "string" && Dn.test(e);
}
function Et() {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID != "function")
    throw i("UNAVAILABLE");
  return globalThis.crypto.randomUUID();
}
function kn(e, n = !1) {
  const o = globalThis.location, s = new URL(String(e), o ? o.href : "http://localhost/");
  if (o && s.origin !== o.origin) {
    if (n !== !0 || o.origin !== "https://shicheng0810.github.io" || s.origin !== "https://question-bank-78u.pages.dev" || s.pathname !== "/api" || s.search || s.hash || s.username || s.password) throw i("ORIGIN_NOT_ALLOWED");
    return `${s.origin}/api`;
  }
  return s.pathname.replace(/\/+$/, "") || "/";
}
function wt(e) {
  return new Promise((n) => setTimeout(n, e));
}
function Pn(e = {}) {
  const n = e.enabled === !0, o = kn(e.apiBase || "/api", e.allowMirrorApi), s = e.fetchImpl || globalThis.fetch.bind(globalThis), u = e.migrationDelay || ((t) => new Promise((r) => setTimeout(r, t))), d = /* @__PURE__ */ new Set(), E = /* @__PURE__ */ new Set(), g = /* @__PURE__ */ new Set();
  let y = 0, A = null, I = null, S = null, _ = n ? "guest" : "off", F = "none", z = null, O = !1, H = null, he = null;
  function Ve() {
    let t;
    try {
      t = globalThis.sessionStorage.getItem(J);
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    if (t === null) return null;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      throw i("INVALID_CLEANUP_RECEIPT");
    }
    const a = (c) => U(c, ["owner", "status"]) && c.status === "cleanup-required" && (c.owner === null || Ge(c.owner));
    if (r.version === 1) {
      if (!U(r, ["version", "owner", "status"]) || !a({ owner: r.owner, status: r.status })) throw i("INVALID_CLEANUP_RECEIPT");
    } else if (r.version !== 2 || !U(r, ["version", "entries"]) || !Array.isArray(r.entries) || !r.entries.length || r.entries.length > 100 || !r.entries.every(a)) throw i("INVALID_CLEANUP_RECEIPT");
    return O = !0, r;
  }
  async function Ut() {
    O = !0;
    const t = Ve(), r = y;
    if (await _n(), l(r), t) {
      const f = t.version === 1 ? [{ owner: t.owner, status: t.status }] : t.entries;
      for (const w of f)
        await ut(w.owner ? { accountId: w.owner.accountId, accountGeneration: w.owner.accountGeneration } : null), l(r);
      if (globalThis.sessionStorage.getItem(J) !== JSON.stringify(t)) throw i("STALE_REQUEST");
      if (globalThis.sessionStorage.removeItem(J), globalThis.sessionStorage.getItem(J) !== null) throw i("STORAGE_UNAVAILABLE");
    }
    const a = await ct();
    if (l(r), O = a.length > 0, !E.size) return;
    for (const f of a)
      if (f.owner)
        try {
          for (const w of E)
            await w({ owner: { ...f.owner }, receipt: { ok: !0, status: "complete" }, cleanupRequired: !0 }), l(r);
          await ft(f.owner), l(r);
        } catch (w) {
          if (l(r), w?.code === "STALE_REQUEST") throw w;
        }
    const c = await ct();
    l(r), O = c.length > 0;
  }
  function b() {
    return {
      enabled: n,
      phase: _,
      epoch: y,
      owner: I ? { ...I } : null,
      pendingDeletion: !!S,
      deletionRecovery: F,
      deletionRecoveryError: z,
      cleanupRequired: O
    };
  }
  function N() {
    const t = b();
    d.forEach((r) => {
      try {
        r(t);
      } catch {
      }
    });
  }
  function Rt() {
    try {
      const t = globalThis.sessionStorage.getItem(Ne);
      return yt(t) ? t : null;
    } catch {
      return null;
    }
  }
  function ye(t) {
    try {
      globalThis.sessionStorage.setItem(Ne, t);
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
  }
  function X() {
    try {
      globalThis.sessionStorage.removeItem(Ne);
    } catch {
    }
  }
  function kt(t) {
    return (t?.version === 1 ? U(t, ["version", "ticket", "expiresAt", "deleteSent"]) : t?.version === ue && U(t, ["version", "ticket", "expiresAt", "deleteSent", "owner"]) && Ge(t.owner)) && typeof t.ticket == "string" && lt.test(t.ticket) && Number.isSafeInteger(t.expiresAt) && t.expiresAt > 0 && typeof t.deleteSent == "boolean";
  }
  function Ge(t) {
    return U(t, ["accountId", "accountGeneration", "expiresAt"]) && Dt.test(t.accountId) && Ot.test(t.accountGeneration) && Number.isSafeInteger(t.expiresAt) && t.expiresAt > 0;
  }
  function te(t) {
    return {
      version: t.version || ue,
      ticket: t.ticket,
      expiresAt: t.expiresAt,
      deleteSent: t.deleteSent,
      ...(t.version || ue) === ue ? { owner: { accountId: t.owner.accountId, accountGeneration: t.owner.accountGeneration, expiresAt: t.owner.expiresAt } } : {}
    };
  }
  function W(t, r) {
    return !!t && !!r && t.version === r.version && t.ticket === r.ticket && t.expiresAt === r.expiresAt && t.deleteSent === r.deleteSent && (t.version === 1 || t.owner?.accountId === r.owner?.accountId && t.owner?.accountGeneration === r.owner?.accountGeneration && t.owner?.expiresAt === r.owner?.expiresAt);
  }
  function Ee() {
    let t;
    try {
      t = globalThis.sessionStorage.getItem(ce);
    } catch {
      return { state: "storage-error", error: "STORAGE_UNAVAILABLE" };
    }
    return t === null ? { state: "none", raw: null } : { state: "raw", raw: t };
  }
  function we(t, r = Date.now()) {
    if (t === null) return { state: "none" };
    if (typeof t != "string") return { state: "invalid", error: "INVALID_DELETION_JOURNAL" };
    let a;
    try {
      a = JSON.parse(t);
    } catch {
      return { state: "invalid", error: "INVALID_DELETION_JOURNAL" };
    }
    return !kt(a) || JSON.stringify(te(a)) !== t ? { state: "invalid", error: "INVALID_DELETION_JOURNAL" } : a.expiresAt <= r ? { state: "expired", error: "DELETION_TICKET_EXPIRED", journal: te(a) } : { state: "valid", journal: te(a) };
  }
  function G() {
    const t = Ee();
    return t.state === "storage-error" ? t : we(t.raw);
  }
  function Me(t, r) {
    if (r !== null && (l(r), t !== null && !L(t, r)))
      throw i("STALE_REQUEST");
  }
  function Pt(t) {
    l(t);
    const r = G();
    if (l(t), r.state !== "none")
      throw r.state === "valid" ? i("DELETE_PENDING") : i(r.error || "STALE_REQUEST");
  }
  function Qe(t, r = null, a = null) {
    const c = te(t);
    try {
      globalThis.sessionStorage.setItem(ce, JSON.stringify(c));
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    Me(r, a);
    const f = G();
    if (Me(r, a), f.state !== "valid" || !W(f.journal, c)) throw i("STORAGE_UNAVAILABLE");
    return c;
  }
  function ne(t, r, a = t) {
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    const c = G();
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    if (c.state === "storage-error") throw i("STORAGE_UNAVAILABLE");
    if (c.state === "expired") throw i("DELETION_TICKET_EXPIRED");
    if (c.state !== "valid" || !W(c.journal, a)) throw i("STALE_REQUEST");
    return c.journal;
  }
  function Ct(t, r) {
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    const a = G();
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    if (a.state === "storage-error") throw i("STORAGE_UNAVAILABLE");
    if (a.state === "expired") throw i("DELETION_TICKET_EXPIRED");
    if (a.state !== "valid" || !W(a.journal, { ...t, deleteSent: a.journal.deleteSent }))
      throw i("STALE_REQUEST");
    if (a.journal.deleteSent !== t.deleteSent) {
      if (l(r), !L(t, r)) throw i("STALE_REQUEST");
      t.deleteSent = a.journal.deleteSent;
    }
    return a.journal;
  }
  function Bt(t, r, a) {
    ne(t, r, a);
    try {
      globalThis.sessionStorage.removeItem(ce);
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    const c = G();
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    if (c.state === "none") {
      if (l(r), !L(t, r)) throw i("STALE_REQUEST");
      return;
    }
    throw c.state === "valid" && W(c.journal, a) ? i("STORAGE_UNAVAILABLE") : c.state === "storage-error" ? i("DELETION_JOURNAL_CLEAR_UNCERTAIN") : i("STALE_REQUEST");
  }
  function P(t = "none", r = null) {
    F = t, z = r;
  }
  function Ie(t) {
    return ++y, re(), A = null, I = null, X(), S = null, _ = "error", P("error", t), N(), i(t);
  }
  function ve(t, r) {
    l(r);
    const a = {
      version: t.version,
      ticket: t.ticket,
      expiresAt: t.expiresAt,
      deleteSent: t.deleteSent,
      epoch: r,
      owner: t.version === 2 ? { ...t.owner } : null
    };
    if (S = a, O = !a.owner || E.size === 0, _ = "deleting", P("pending"), N(), !L(a, r)) throw i("STALE_REQUEST");
    return a;
  }
  function $e(t) {
    const r = ++y;
    re(), A = null, I = null, X(), l(r);
    const a = G();
    if (a.state !== "valid" || !W(a.journal, t))
      throw l(r), Ie(a.error || "STALE_REQUEST");
    return ve(a.journal, r);
  }
  function Y() {
    if (S) throw i("DELETE_PENDING");
    const t = G();
    if (t.state !== "none")
      throw t.state === "valid" ? ($e(t.journal), i("DELETE_PENDING")) : Ie(t.error);
  }
  function re() {
    g.forEach((t) => t.abort()), g.clear();
  }
  function Z(t = "guest") {
    const r = ++y;
    return re(), A = null, I = null, X(), _ = t, N(), r;
  }
  function l(t) {
    if (t !== y) throw i("STALE_REQUEST");
  }
  async function K(t, r = {}, a = y) {
    l(a);
    const c = new AbortController();
    g.add(c);
    const f = new Headers(r.headers || {});
    f.set("Accept", "application/json");
    const w = r.body;
    w != null && !f.has("Content-Type") && f.set("Content-Type", "application/json");
    try {
      return await s(`${o}${t}`, {
        ...r,
        headers: f,
        body: w == null ? void 0 : JSON.stringify(w),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: c.signal
      });
    } catch (h) {
      throw a !== y || h?.name === "AbortError" ? i("STALE_REQUEST") : i("UNAVAILABLE");
    } finally {
      g.delete(c);
    }
  }
  async function ee(t, r = [200], a = y) {
    let c;
    try {
      c = await t.json();
    } catch {
      throw l(a), i("UNAVAILABLE");
    }
    if (l(a), !r.includes(t.status))
      throw t.status === 401 ? i("AUTH_FAILED") : t.status === 429 ? i("RATE_LIMITED") : i("UNAVAILABLE");
    if (!c || typeof c != "object" || Array.isArray(c)) throw i("UNAVAILABLE");
    return c;
  }
  async function jt(t, r) {
    const a = await K("/v2/auth", { method: "POST", body: t }, r), c = await ee(a, [200], r);
    if (l(r), !U(c, ["ok", "token"]) || c.ok !== !0 || !yt(c.token))
      throw i("AUTH_FAILED");
    return c.token;
  }
  async function Ke(t, r) {
    const a = await K("/v2/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}` }
    }, r), c = await ee(a, [200], r);
    if (!Rn(c)) throw i("AUTH_FAILED");
    return l(r), {
      accountId: c.accountId,
      accountGeneration: c.accountGeneration,
      expiresAt: c.expiresAt
    };
  }
  async function Vt() {
    if (!n) return b();
    if (await Ut(), S) return oe();
    if (H && he === y) return H;
    const t = G();
    if (t.state !== "none") {
      if (t.state !== "valid") throw Ie(t.error);
      return $e(t.journal), oe();
    }
    P();
    const r = Rt(), a = Z(r ? "checking" : "guest");
    if (!r) return b();
    try {
      l(a), ye(r);
    } catch (f) {
      if (f?.code === "STALE_REQUEST") throw f;
      try {
        l(a);
      } catch {
        throw f;
      }
      throw _ = "error", N(), f;
    }
    const c = Ke(r, a).then((f) => (l(a), ye(r), A = r, I = f, _ = "ready", N(), b())).catch((f) => {
      if (f?.code === "STALE_REQUEST") return b();
      throw l(a), A = null, I = null, f?.code === "AUTH_FAILED" && X(), _ = f?.code === "AUTH_FAILED" ? "guest" : "error", N(), f;
    }).finally(() => {
      H === c && (H = null, he = null);
    });
    return H = c, he = a, c;
  }
  async function Je(t, r) {
    const a = await Ke(t, r);
    return l(r), ye(t), A = t, I = a, _ = "ready", N(), b();
  }
  async function Gt(t, r = () => {
  }) {
    if (!n) throw i("DISABLED");
    Y();
    const a = String(t || "").trim();
    if (a.length < 4 || a.length > 64) throw i("INVALID_INPUT");
    const c = Z("authenticating");
    try {
      let f = null;
      for (let w = 0; w < be; w += 1) {
        const h = await K("/v2/auth", { method: "POST", body: { action: "login", code: a } }, c);
        let x;
        try {
          x = await h.json();
        } catch {
          throw l(c), i("UNAVAILABLE");
        }
        l(c);
        let T;
        try {
          T = bn(h.status, x);
        } catch (C) {
          if (C?.code !== "RATE_LIMITED") throw C;
          const D = h.headers.get("Retry-After"), B = D && /^\d{1,4}$/.test(D) ? Math.min(Un, Math.max(1, Number(D))) : 5;
          if (w === be - 1) throw i("MIGRATION_PENDING", { migration: f, retryAfterMs: B * 1e3 });
          await u(Math.max(ht, B * 1e3)), l(c);
          continue;
        }
        if (T.state === "ready") return await Je(T.token, c);
        f = T.migration;
        try {
          r(structuredClone(f));
        } catch {
        }
        if (w === be - 1) throw i("MIGRATION_PENDING", { migration: f, retryAfterMs: T.retryAfterMs });
        await u(Math.min(xn, Math.max(ht, T.retryAfterMs))), l(c);
      }
      throw i("MIGRATION_PENDING", { migration: f });
    } catch (f) {
      if (f?.code !== "STALE_REQUEST") {
        try {
          l(c);
        } catch {
          throw f;
        }
        _ = f?.code === "AUTH_FAILED" ? "guest" : "error", N();
      }
      throw f;
    }
  }
  async function Mt(t, r) {
    if (!n) throw i("DISABLED");
    Y();
    const a = String(t || "").trim();
    if (a.length < 4 || a.length > 64 || typeof r != "function") throw i("INVALID_INPUT");
    const c = Z("authenticating");
    try {
      const f = Et(), w = await K("/v2/auth", {
        method: "POST",
        body: { action: "prepare-register", code: a, opId: f }
      }, c), h = await ee(w, [200], c);
      if (l(c), !U(h, ["ok", "intent", "expiresAt"]) || h.ok !== !0 || typeof h.intent != "string" || !/^ri1\.[0-9a-f]{64}$/.test(h.intent) || !Number.isSafeInteger(h.expiresAt) || h.expiresAt <= Date.now()) throw i("UNAVAILABLE");
      l(c);
      const x = await r();
      if (l(c), !x)
        return _ = "guest", N(), { ...b(), cancelled: !0 };
      const T = await jt({ action: "register", code: a, opId: f, intent: h.intent }, c);
      return await Je(T, c);
    } catch (f) {
      if (f?.code !== "STALE_REQUEST") {
        try {
          l(c);
        } catch {
          throw f;
        }
        _ = f?.code === "AUTH_FAILED" ? "guest" : "error", N();
      }
      throw f;
    }
  }
  function Qt() {
    return n && (Y(), Z("guest")), b();
  }
  async function vt(t) {
    if (!n || (Y(), !A || !I || typeof t != "function")) throw i("AUTH_FAILED");
    const r = y, a = A, c = { ...I };
    if (!await t()) return { ...b(), cancelled: !0 };
    if (l(r), A !== a || !I || I.accountId !== c.accountId || I.accountGeneration !== c.accountGeneration) throw i("STALE_REQUEST");
    const f = Z("deleting");
    try {
      const w = await K("/v2/account", {
        method: "POST",
        headers: { Authorization: `Bearer ${a}` },
        body: { action: "prepare-delete", opId: Et() }
      }, f), h = await ee(w, [200], f);
      if (l(f), !U(h, ["ok", "ticket", "expiresAt"]) || h.ok !== !0 || typeof h.ticket != "string" || !lt.test(h.ticket) || !Number.isSafeInteger(h.expiresAt) || h.expiresAt <= Date.now()) throw i("UNAVAILABLE");
      l(f), Pt(f);
      const x = Qe({
        owner: c,
        ticket: h.ticket,
        expiresAt: h.expiresAt,
        deleteSent: !1
      }, null, f);
      return l(f), ve(x, f), oe();
    } catch (w) {
      if (w?.code === "STALE_REQUEST") throw w;
      try {
        l(f);
      } catch {
        throw w;
      }
      throw _ = "error", P("error", w?.code || "UNAVAILABLE"), N(), w;
    }
  }
  let j = null;
  function L(t, r) {
    return y === r && S === t && t.epoch === r;
  }
  function M(t) {
    if (l(t.epoch), _ !== "error" || F !== "error" || z !== t.code || S !== t.deletion)
      throw i("STALE_REQUEST");
    if (j !== null) throw i("DELETE_PENDING");
  }
  function qe(t) {
    M(t);
    const r = Ee();
    if (M(t), r.state === "storage-error") throw i("STORAGE_UNAVAILABLE");
    return r.raw;
  }
  function Fe(t, r) {
    const a = we(r);
    if (a.state === "valid") throw i("DELETE_PENDING");
    const c = t.code === "INVALID_DELETION_JOURNAL" ? "invalid" : t.code === "DELETION_TICKET_EXPIRED" ? "expired" : "none";
    if (a.state !== c) throw i("STALE_REQUEST");
    return a;
  }
  function ze(t, r) {
    return M(t), _ = "error", P("error", r), N(), i(r);
  }
  function He(t) {
    M(t);
    const r = ++y;
    if (re(), A = null, I = null, X(), y !== r) throw i("STALE_REQUEST");
    return S = null, _ = "guest", P(), N(), b();
  }
  function Q(t, r, a) {
    return L(t, r) && (_ = "error", P("error", a?.code || "UNAVAILABLE"), N()), a;
  }
  async function $t(t, r) {
    let a = 0;
    for (; S === t && t.epoch === r && a < At && t.expiresAt > Date.now(); ) {
      l(r);
      let c;
      try {
        c = Ct(t, r);
      } catch (h) {
        throw h?.code === "STALE_REQUEST" ? h : Q(t, r, h);
      }
      const f = t.deleteSent ? "status" : "delete";
      a += 1;
      let w;
      try {
        const h = await K("/v2/account", {
          method: "POST",
          body: { action: f, ticket: t.ticket }
        }, r);
        if (w = await ee(h, [200, 202], r), l(r), !L(t, r)) throw i("STALE_REQUEST");
        if (!U(w, ["ok", "status"]) || w.ok !== !0 || !["pending", "complete"].includes(w.status)) throw i("UNAVAILABLE");
        ne(t, r, c);
      } catch (h) {
        if (h?.code === "STALE_REQUEST") throw h;
        if (Q(t, r, h), f === "delete" && h?.code === "UNAVAILABLE" && a < At) {
          await wt(250);
          continue;
        }
        throw h;
      }
      if (w.status === "complete") {
        if (!L(t, r)) throw i("STALE_REQUEST");
        const h = t.owner ? { accountId: t.owner.accountId, accountGeneration: t.owner.accountGeneration } : null;
        O = !0;
        try {
          await ut(h), l(r);
        } catch (T) {
          throw T?.code === "STALE_REQUEST" || !L(t, r) ? i("STALE_REQUEST") : Q(t, r, T);
        }
        if (!L(t, r)) throw i("STALE_REQUEST");
        O = !t.owner || E.size === 0;
        const x = { owner: t.owner ? { ...t.owner } : null, receipt: { ok: !0, status: "complete" }, cleanupRequired: O };
        try {
          for (const T of E)
            if (await T(structuredClone(x)), !L(t, r)) throw i("STALE_REQUEST");
        } catch (T) {
          if (O = !0, T?.code === "STALE_REQUEST" || !L(t, r)) throw i("STALE_REQUEST");
        }
        if (!O) {
          O = !0;
          try {
            await ft(h), l(r), O = !1;
          } catch (T) {
            throw T?.code === "STALE_REQUEST" || !L(t, r) ? i("STALE_REQUEST") : Q(t, r, T);
          }
        }
        if (O)
          try {
            const T = Ve(), C = { owner: t.owner ? { ...t.owner } : null, status: "cleanup-required" }, D = T ? T.version === 1 ? [{ owner: T.owner, status: T.status }] : T.entries : [];
            if (D.some((se) => se.owner?.accountId === C.owner?.accountId && se.owner?.accountGeneration === C.owner?.accountGeneration) || D.push(C), D.length > 100) throw i("LOCAL_CLEANUP_QUEUE_FULL");
            const B = JSON.stringify(D.length === 1 && !T ? { version: 1, ...C } : { version: 2, entries: D });
            if (globalThis.sessionStorage.setItem(J, B), globalThis.sessionStorage.getItem(J) !== B) throw i("STORAGE_UNAVAILABLE");
          } catch (T) {
            throw Q(t, r, T?.code ? T : i("STORAGE_UNAVAILABLE"));
          }
        try {
          Bt(t, r, c);
        } catch (T) {
          throw T?.code === "STALE_REQUEST" ? T : Q(t, r, T);
        }
        return S = null, P(), I || (_ = "deleted"), N(), b();
      }
      if (!L(t, r)) throw i("STALE_REQUEST");
      if (!t.deleteSent) {
        try {
          ne(t, r, c), Qe({ ...t, deleteSent: !0 }, t, r), ne(t, r, { ...c, deleteSent: !0 });
        } catch (h) {
          throw h?.code === "STALE_REQUEST" ? h : Q(t, r, h);
        }
        if (l(r), !L(t, r)) throw i("STALE_REQUEST");
        t.deleteSent = !0;
      }
      _ = "deleting", P("pending"), N(), await wt(250);
    }
    throw L(t, r) ? (_ = "error", P("error", t.expiresAt <= Date.now() ? "DELETION_TICKET_EXPIRED" : "UNAVAILABLE"), N(), i(z)) : i("STALE_REQUEST");
  }
  function oe() {
    if (!S) return Promise.resolve(b());
    if (S.epoch !== y) return Promise.reject(i("STALE_REQUEST"));
    if (j && j.deletion === S && j.epoch === y)
      return j.promise;
    const t = S, r = y;
    let a;
    return a = Promise.resolve().then(() => $t(t, r)).finally(() => {
      j && j.promise === a && (j = null);
    }), j = { deletion: t, epoch: r, promise: a }, _ = "deleting", N(), a;
  }
  async function Kt(t) {
    if (!n) return b();
    if (typeof t != "function") throw i("INVALID_INPUT");
    const r = {
      epoch: y,
      deletion: S,
      code: z
    };
    if (!["INVALID_DELETION_JOURNAL", "DELETION_TICKET_EXPIRED", "DELETION_JOURNAL_CLEAR_UNCERTAIN"].includes(r.code))
      throw i("STALE_REQUEST");
    const a = qe(r);
    if (Fe(r, a), !await t()) return { ...b(), cancelled: !0 };
    M(r);
    const f = qe(r), w = Fe(r, f);
    if (f !== a) throw i("STALE_REQUEST");
    if (r.code === "DELETION_JOURNAL_CLEAR_UNCERTAIN") {
      if (w.state !== "none") throw i("STALE_REQUEST");
      return He(r);
    }
    try {
      globalThis.sessionStorage.removeItem(ce);
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    M(r);
    const h = Ee();
    if (M(r), h.state === "storage-error")
      throw ze(r, "DELETION_JOURNAL_CLEAR_UNCERTAIN");
    if (we(h.raw).state === "none") return He(r);
    throw ze(r, "STALE_REQUEST");
  }
  function Jt(t) {
    if (typeof t != "function") throw i("INVALID_INPUT");
    return d.add(t), t(b()), () => d.delete(t);
  }
  function qt(t) {
    if (typeof t != "function") throw i("INVALID_INPUT");
    return E.add(t), () => E.delete(t);
  }
  async function Ft(t) {
    if (!n || _ !== "ready" || !I || !A || I.expiresAt <= Date.now()) throw i("AUTH_FAILED");
    if (Y(), !t || !U(t, Object.hasOwn(t, "body") ? ["path", "method", "body"] : ["path", "method"])) throw i("INVALID_INPUT");
    const r = new URL(String(t.path), "http://bounded.invalid");
    if (r.origin !== "http://bounded.invalid" || !t.path.startsWith("/v2/") || r.hash) throw i("INVALID_INPUT");
    const c = {
      "/v2/sync/push": { methods: ["POST"], keys: [], max: 256 * 1024 },
      "/v2/sync/pull": { methods: ["GET"], keys: ["after", "until", "limit"] },
      "/v2/content/chunks": { methods: ["GET", "PUT"], keys: ["contentDigest", "chunkIndex"], max: 512 * 1024 },
      "/v2/content/manifests": { methods: ["POST", "GET"], keys: ["contentDigest"], max: 128 * 1024 },
      "/v2/export/start": { methods: ["POST"], keys: [], max: 2048 },
      "/v2/export/reset": { methods: ["POST"], keys: [], max: 2048 },
      "/v2/export/page": { methods: ["GET"], keys: ["exportId", "section", "after", "limit"] },
      "/v2/export/chunk": { methods: ["GET"], keys: ["exportId", "contentDigest", "chunkIndex"] },
      "/v2/legacy/history": { methods: ["GET"], keys: ["limit", "cursor", "id"], max: 409600 },
      "/v2/legacy/banks": { methods: ["GET"], keys: ["limit", "cursor", "id", "chunkIndex", "part"], max: 256 * 1024 }
    }[r.pathname], f = [...r.searchParams.keys()];
    if (!c || !c.methods.includes(t.method) || f.some((R) => !c.keys.includes(R)) || new Set(f).size !== f.length || t.method === "GET" && Object.hasOwn(t, "body")) throw i("INVALID_INPUT");
    let w;
    const h = new Headers({ Accept: "application/json" });
    if (Object.hasOwn(t, "body")) {
      if (r.pathname === "/v2/content/chunks") {
        if (!(t.body instanceof Uint8Array)) throw i("INVALID_INPUT");
        w = new Uint8Array(t.body), h.set("Content-Type", "application/octet-stream");
      } else {
        try {
          w = de(t.body);
        } catch {
          throw i("INVALID_INPUT");
        }
        h.set("Content-Type", "application/json");
      }
      if (!c.max || w.byteLength > c.max) throw i("BODY_TOO_LARGE");
    }
    const x = y, T = { ...I }, C = A, D = () => {
      if (l(x), _ !== "ready" || A !== C || !I || I.accountId !== T.accountId || I.accountGeneration !== T.accountGeneration) throw i("STALE_REQUEST");
    };
    D(), h.set("Authorization", `Bearer ${C}`);
    const B = new AbortController();
    g.add(B);
    const se = setTimeout(() => B.abort(), 3e4);
    try {
      const R = await s(`${o}${r.pathname}${r.search}`, { method: t.method, headers: h, body: w, credentials: "omit", cache: "no-store", redirect: "error", signal: B.signal });
      D();
      const ie = R.body?.getReader();
      if (!ie) throw i("UNAVAILABLE");
      let Te = 0;
      const Xe = [], zt = Math.min(512 * 1024, c.max || 512 * 1024);
      try {
        for (; ; ) {
          const V = await ie.read();
          if (D(), V.done) break;
          if (Te += V.value.length, Te > zt)
            throw await ie.cancel(), i("RESPONSE_TOO_LARGE");
          Xe.push(V.value);
        }
      } finally {
        ie.releaseLock();
      }
      const pe = new Uint8Array(Te);
      let We = 0;
      for (const V of Xe)
        pe.set(V, We), We += V.length;
      D();
      let ge;
      const _e = R.ok && ["/v2/legacy/history", "/v2/legacy/banks"].includes(r.pathname) && r.searchParams.has("id");
      if (R.ok && (["/v2/content/chunks", "/v2/export/chunk"].includes(r.pathname) || _e) && t.method === "GET") ge = pe;
      else
        try {
          ge = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(pe));
        } catch {
          throw i("UNAVAILABLE");
        }
      D();
      const me = R.headers.get("Retry-After"), Ye = {};
      if (_e) for (const V of ["content-type", "content-length", "x-legacy-source-key", "x-legacy-source-sha256", "x-legacy-byte-length", "x-legacy-chunk-sha256", "x-legacy-chunk-index", "x-legacy-chunk-count"]) {
        const Ze = R.headers.get(V);
        Ze !== null && (Ye[V] = Ze);
      }
      return { status: R.status, body: ge, ..._e ? { headers: Ye } : {}, retryAfter: me && /^[1-9][0-9]{0,3}$/.test(me) ? Number(me) : null, epoch: x, owner: T };
    } catch (R) {
      throw x !== y ? i("STALE_REQUEST") : R instanceof xt ? R : i("UNAVAILABLE");
    } finally {
      clearTimeout(se), g.delete(B);
    }
  }
  return Object.freeze({
    enabled: n,
    snapshot: b,
    subscribe: Jt,
    resume: Vt,
    login: Gt,
    register: Mt,
    logout: Qt,
    deleteAccount: vt,
    acknowledgeRecovery: Kt,
    continueDeletion: oe,
    authenticatedTransport: Ft,
    subscribeDeletionComplete: qt
  });
}
export {
  Ne as ACCOUNT_V2_SESSION_KEY,
  Ne as ACCOUNT_V2_TOKEN_KEY,
  xt as AccountV2Error,
  Pn as createAccountV2Controller
};
