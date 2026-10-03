const Be = Object.freeze({
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
}), Xt = Object.freeze(["sourceKey", "legacyRevision", "legacyId"]), pt = new TextEncoder(), Wt = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
class Yt extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(n, o, s) {
    super(s), this.name = "AppDataValidationError", this.code = n, this.path = o;
  }
}
function S(e, n, o) {
  throw new Yt(e, n, o);
}
function Tt(e) {
  return typeof e != "string" && S("type", "$", "UTF-8 length requires a string"), pt.encode(e).byteLength;
}
function tt(e, n, o) {
  const s = Tt(e);
  return s > o.maxStringUtf8Bytes && S("utf8_limit", n, "string exceeds the configured UTF-8 limit"), s;
}
function Zt(e) {
  if (e === "0") return !0;
  if (!/^[1-9][0-9]*$/.test(e)) return !1;
  const n = Number(e);
  return Number.isSafeInteger(n) && n < 4294967295 && String(n) === e;
}
function nt(e) {
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
    const u = Tt(n);
    u > s.maxCanonicalUtf8Bytes - this.bytes && S("utf8_limit", o, "canonical JSON exceeds the total AppData bound"), this.parts.push(n), this.bytes += u;
  }
  /** @returns {Uint8Array} */
  finish() {
    return pt.encode(this.parts.join(""));
  }
}
function xe(e, n, o, s, u, d) {
  if (o > d.maxDepth && S("depth_limit", n, "value exceeds configured nesting depth"), e === null) {
    u.append("null", n, d);
    return;
  }
  if (typeof e == "boolean") {
    u.append(e ? "true" : "false", n, d);
    return;
  }
  if (typeof e == "string") {
    tt(e, n, d), nt(e) > d.maxCanonicalUtf8Bytes - u.bytes && S("utf8_limit", n, "canonical JSON exceeds the total AppData bound"), u.append(JSON.stringify(e), n, d);
    return;
  }
  if (typeof e == "number") {
    Number.isFinite(e) || S("finite_number", n, "must be a finite number"), u.append(JSON.stringify(Object.is(e, -0) ? 0 : e), n, d);
    return;
  }
  if ((typeof e != "object" || e === null) && S("type", n, "value is not JSON data"), s.has(e) && S("cycle", n, "cyclic values are not JSON data"), s.add(e), Array.isArray(e)) {
    Object.getPrototypeOf(e) !== Array.prototype && S("prototype", n, "array must use Array.prototype");
    const E = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(e)
    ), _ = E.length;
    (!_ || !Object.hasOwn(_, "value") || typeof _.value != "number") && S("descriptor", n, "array length must be a data property");
    const y = _.value;
    (!Number.isSafeInteger(y) || y > d.maxArrayItems) && S("array_limit", n, "array exceeds configured item limit");
    for (const h of Reflect.ownKeys(E)) {
      if (h === "length") continue;
      (typeof h != "string" || !Zt(h) || Number(h) >= y) && S("array_property", n, "arrays may not have non-index properties");
      const I = E[h];
      (!I || !Object.hasOwn(I, "value") || !I.enumerable) && S("accessor", `${n}[${h}]`, "array elements must be enumerable data properties");
    }
    u.append("[", n, d);
    for (let h = 0; h < y; h += 1) {
      h > 0 && u.append(",", n, d);
      const I = String(h), m = E[I];
      m || S("array_hole", `${n}[${h}]`, "array holes are not JSON"), xe(m.value, `${n}[${h}]`, o + 1, s, u, d);
    }
    u.append("]", n, d);
  } else {
    Object.getPrototypeOf(e) !== Object.prototype && S("prototype", n, "object must use Object.prototype");
    const E = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(e)
    ), _ = Reflect.ownKeys(E);
    _.length > d.maxObjectKeys && S("object_limit", n, "object exceeds configured key limit");
    const y = [];
    for (const h of _) {
      typeof h != "string" && S("symbol", n, "symbol keys are not JSON"), Wt.has(h) && S("prototype_pollution", `${n}.${h}`, "prototype-pollution key is forbidden");
      const I = E[h];
      (!I || !Object.hasOwn(I, "value")) && S("accessor", `${n}.${h}`, "accessors are not JSON"), I.enumerable || S("non_enumerable", `${n}.${h}`, "non-enumerable fields cannot be silently omitted"), tt(h, `${n}.${h}`, d), y.push(h);
    }
    y.sort(), u.append("{", n, d);
    for (let h = 0; h < y.length; h += 1) {
      const I = y[h];
      typeof I != "string" && S("descriptor", n, "object key must be a string"), h > 0 && u.append(",", n, d);
      const m = E[I];
      (!m || !Object.hasOwn(m, "value")) && S("accessor", `${n}.${I}`, "accessors are not JSON");
      const g = nt(I), F = d.maxCanonicalUtf8Bytes - u.bytes;
      g + 1 > F && S("utf8_limit", `${n}.${I}`, "canonical JSON exceeds the total AppData bound"), u.append(`${JSON.stringify(I)}:`, `${n}.${I}`, d), xe(m.value, `${n}.${I}`, o + 1, s, u, d);
    }
    u.append("}", n, d);
  }
  s.delete(e);
}
function de(e) {
  const n = new en();
  return xe(e, "$", 0, /* @__PURE__ */ new WeakSet(), n, Be), n.finish();
}
const De = (e, n) => n.some((o) => e instanceof o);
let rt, ot;
function tn() {
  return rt || (rt = [
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction
  ]);
}
function nn() {
  return ot || (ot = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}
const Oe = /* @__PURE__ */ new WeakMap(), me = /* @__PURE__ */ new WeakMap(), le = /* @__PURE__ */ new WeakMap();
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
  if (Oe.has(e))
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
  Oe.set(e, n);
}
let Ue = {
  get(e, n, o) {
    if (e instanceof IDBTransaction) {
      if (n === "done")
        return Oe.get(e);
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
function _t(e) {
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
  return typeof e == "function" ? sn(e) : (e instanceof IDBTransaction && on(e), De(e, tn()) ? new Proxy(e, Ue) : e);
}
function v(e) {
  if (e instanceof IDBRequest)
    return rn(e);
  if (me.has(e))
    return me.get(e);
  const n = an(e);
  return n !== e && (me.set(e, n), le.set(n, e)), n;
}
const Re = (e) => le.get(e);
function cn(e, n, { blocked: o, upgrade: s, blocking: u, terminated: d } = {}) {
  const E = indexedDB.open(e, n), _ = v(E);
  return s && E.addEventListener("upgradeneeded", (y) => {
    s(v(E.result), y.oldVersion, y.newVersion, v(E.transaction), y);
  }), o && E.addEventListener("blocked", (y) => o(
    // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
    y.oldVersion,
    y.newVersion,
    y
  )), _.then((y) => {
    d && y.addEventListener("close", () => d()), u && y.addEventListener("versionchange", (h) => u(h.oldVersion, h.newVersion, h));
  }).catch(() => {
  }), _;
}
const un = ["get", "getKey", "getAll", "getAllKeys", "count"], fn = ["put", "add", "delete", "clear"], Le = /* @__PURE__ */ new Map();
function st(e, n) {
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
  const d = async function(E, ..._) {
    const y = this.transaction(E, u ? "readwrite" : "readonly");
    let h = y.store;
    return s && (h = h.index(_.shift())), (await Promise.all([
      h[o](..._),
      u && y.done
    ]))[0];
  };
  return Le.set(n, d), d;
}
_t((e) => ({
  ...e,
  get: (n, o, s) => st(n, o) || e.get(n, o, s),
  has: (n, o) => !!st(n, o) || e.has(n, o)
}));
const dn = ["continue", "continuePrimaryKey", "advance"], it = {}, ke = /* @__PURE__ */ new WeakMap(), gt = /* @__PURE__ */ new WeakMap(), ln = {
  get(e, n) {
    if (!dn.includes(n))
      return e[n];
    let o = it[n];
    return o || (o = it[n] = function(...s) {
      ke.set(this, gt.get(this)[n](...s));
    }), o;
  }
};
async function* hn(...e) {
  let n = this;
  if (n instanceof IDBCursor || (n = await n.openCursor(...e)), !n)
    return;
  n = n;
  const o = new Proxy(n, ln);
  for (gt.set(o, n), le.set(o, Re(n)); n; )
    yield o, n = await (ke.get(o) || n.continue()), ke.delete(o);
}
function at(e, n) {
  return n === Symbol.asyncIterator && De(e, [IDBIndex, IDBObjectStore, IDBCursor]) || n === "iterate" && De(e, [IDBIndex, IDBObjectStore]);
}
_t((e) => ({
  ...e,
  get(n, o, s) {
    return at(n, o) ? hn : e.get(n, o, s);
  },
  has(n, o) {
    return at(n, o) || e.has(n, o);
  }
}));
const An = 100 * 1024 * 1024, yn = 200, En = 128 * 1024;
Object.freeze({ maxContentBytes: An, maxChunks: yn, maxManifestBytes: En, maxChunkBytes: Be.maxContentChunkBytes, maxContentCanonicalBytes: Ht.maxCanonicalUtf8Bytes });
Be.maxArrayItems;
const T = (e, n, o = !1) => ({ name: e, keyPath: n, unique: o });
function St(e) {
  if (e && typeof e == "object" && !Object.isFrozen(e)) {
    Object.freeze(e);
    for (const n of Reflect.ownKeys(e)) St(e[n]);
  }
  return e;
}
St({
  history_snapshots: { keyPath: "snapshotId", indexes: [T("recordedAt", "recordedAt"), T("accountGeneration", "accountGeneration")] },
  meta: { keyPath: "key", indexes: [] },
  bank_revisions: { keyPath: ["bankUid", "revision"], indexes: [T("bankUid", "bankUid")] },
  content_chunks: { keyPath: ["contentDigest", "chunkIndex"], indexes: [T("contentDigest", "contentDigest")] },
  question_aliases: { keyPath: Xt, indexes: [T("sourceKey", "sourceKey"), T("mappingStatus", "mappingStatus"), T("newQuestionKey", "newQuestionKey")] },
  attempts: { keyPath: "attemptId", indexes: [T("status", "status"), T("startedAt", "startedAt")] },
  attempt_scope: { keyPath: ["attemptId", "ordinal"], indexes: [T("attemptId", "attemptId")] },
  drafts: { keyPath: ["attemptId", "questionKey"], indexes: [T("attemptId", "attemptId")] },
  answer_events: { keyPath: "eventId", indexes: [T("attemptId", "attemptId"), T("questionKey", "questionKey"), T("attemptAction", ["attemptId", "writerStreamId", "actionSeq"], !0)] },
  user_state: { keyPath: ["questionKey", "field"], indexes: [T("starredKey", "starredKey"), T("serverRevision", "serverRevision")] },
  mutations: { keyPath: "mutationId", indexes: [T("streamSequence", ["clientStreamId", "clientSeq"], !0)] },
  outbox: { keyPath: "mutationId", indexes: [T("nextAttemptAt", "nextAttemptAt")] },
  conflicts: { keyPath: "conflictId", indexes: [T("entityKey", "entityKey"), T("status", "status")] },
  legacy_raw: { keyPath: ["sourceId", "sourceDigest", "chunkIndex"], indexes: [T("sourceId", "sourceId")] },
  legacy_aggregates: { keyPath: ["sourceId", "namespace", "legacyQuestionId"], indexes: [T("mappingStatus", "mappingStatus")] },
  migration_journal: { keyPath: "migrationId", indexes: [T("status", "status")] },
  import_receipts: { keyPath: ["sourceId", "sourceRecordId"], indexes: [] },
  checkpoints: { keyPath: "checkpointId", indexes: [T("createdAt", "createdAt")] },
  entity_tombstones: { keyPath: "entityKey", indexes: [T("entityKind", "entityKind"), T("accountGeneration", "accountGeneration")] },
  writer_leases: { keyPath: "attemptId", indexes: [T("expiresAt", "expiresAt")] }
});
function wn(e, n, o) {
  const s = new Error(n);
  return s.name = "StorageError", s.code = e, s;
}
const Pe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, mt = Object.prototype.hasOwnProperty;
function $(e, n, o) {
  return wn(e, n);
}
function In(e, n) {
  if (e === null || typeof e != "object" || Array.isArray(e) || Object.getPrototypeOf(e) !== Object.prototype || Object.getOwnPropertySymbols(e).length)
    throw $("CORRUPT", `${n} must be a plain data record`);
  for (const o of Object.getOwnPropertyNames(e)) {
    const s = Object.getOwnPropertyDescriptor(e, o);
    if (!s || !mt.call(s, "value")) throw $("CORRUPT", `${n}.${o} must be a data property`);
  }
  return (
    /** @type {Record<string, unknown>} */
    e
  );
}
function ct(e, n, o, s) {
  const u = /* @__PURE__ */ new Set([...n, ...o]);
  if (Object.keys(e).some((d) => !u.has(d)) || n.some((d) => !mt.call(e, d)))
    throw $("CORRUPT", `${s} has an unsupported shape`);
}
function pn(e) {
  const n = In(e, "owner");
  if (n.ownerKind === "guest") {
    if (ct(n, ["ownerKind", "guestId"], [], "owner"), !Pe.test(
      /** @type {string} */
      n.guestId
    )) throw $("INVALID", "guestId must be a UUIDv4");
    return Object.freeze({ ownerKind: "guest", guestId: (
      /** @type {string} */
      n.guestId
    ) });
  }
  if (n.ownerKind === "account") {
    if (ct(n, ["ownerKind", "accountId", "accountGeneration"], [], "owner"), typeof n.accountId != "string" || n.accountId.length === 0 || new TextEncoder().encode(n.accountId).byteLength > 512 || !Pe.test(
      /** @type {string} */
      n.accountGeneration
    ))
      throw $("INVALID", "account owner must have a bounded accountId and accountGeneration");
    return Object.freeze({ ownerKind: "account", accountId: n.accountId, accountGeneration: n.accountGeneration });
  }
  throw $("INVALID", "ownerKind must be guest or account");
}
function Tn(e) {
  const n = typeof e == "string" && e.startsWith("qb-v2-business-") ? "qb-v2-business-" : "qb-b1a-test-business-";
  if (typeof e != "string" || !e.startsWith(n) || !Pe.test(e.slice(n.length))) throw $("CORRUPT", "business dbName is not a generated profile name");
  return e;
}
const q = "completedDeletes", Lt = 100, k = (e) => Object.assign(new Error(e), { code: e }), fe = (e, n) => e && typeof e == "object" && !Array.isArray(e) && Object.keys(e).sort().join() === n.slice().sort().join();
function he(e) {
  if (de(e), e === null) return null;
  if (!fe(e, ["accountId", "accountGeneration"]) || !/^[0-9a-f]{64}$/.test(e.accountId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.accountGeneration)) throw k("INVALID_CLEANUP_RECEIPT");
  return { ...e };
}
const Ce = (e) => JSON.stringify(e && [e.accountId, e.accountGeneration]);
function je(e) {
  if (e === void 0) return { key: q, version: 1, entries: [] };
  if (de(e), !fe(e, ["key", "version", "entries"]) || e.key !== q || e.version !== 1 || !Array.isArray(e.entries) || e.entries.length > Lt) throw k("INVALID_CLEANUP_RECEIPT");
  const n = /* @__PURE__ */ new Set(), o = e.entries.map((s) => {
    if (!fe(s, ["owner", "status"]) || s.status !== "server-complete") throw k("INVALID_CLEANUP_RECEIPT");
    const u = he(s.owner), d = Ce(u);
    if (n.has(d)) throw k("INVALID_CLEANUP_RECEIPT");
    return n.add(d), { owner: u, status: "server-complete" };
  });
  return { key: q, version: 1, entries: o };
}
function Nt(e, n, o = !1) {
  const s = je(e), u = he(n), d = Ce(u), E = s.entries.filter((_) => Ce(_.owner) !== d);
  if (o || E.push({ owner: u, status: "server-complete" }), E.length > Lt) throw k("LOCAL_CLEANUP_QUEUE_FULL");
  return { ...s, entries: E };
}
function _n(e) {
  if (e?.state !== "cleanup_pending") return;
  if (de(e), !fe(e, ["key", "owner", "controlId", "state", "cleanupDbs"])) throw k("INVALID_CLEANUP_RECEIPT");
  const n = pn(e.owner);
  if (n.ownerKind !== "account") throw k("INVALID_CLEANUP_RECEIPT");
  const o = he({ accountId: n.accountId, accountGeneration: n.accountGeneration });
  if (e.key !== JSON.stringify(["account", o.accountId, o.accountGeneration]) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.controlId) || !Array.isArray(e.cleanupDbs) || e.cleanupDbs.length > 1e3 || new Set(e.cleanupDbs).size !== e.cleanupDbs.length) throw k("INVALID_CLEANUP_RECEIPT");
  for (const s of e.cleanupDbs) Tn(s);
  return o;
}
async function Me() {
  let e = !1, n;
  const o = cn("qb-v2-profile-directory", 1, { upgrade(u, d, E, _) {
    if (e || d !== 0) {
      _.abort();
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
async function ut() {
  const e = await Me();
  try {
    return je(await e.get("meta", q)).entries;
  } finally {
    e.close();
  }
}
async function gn() {
  const e = await Me();
  try {
    const n = e.transaction(["owners", "meta"], "readwrite");
    try {
      let o = je(await n.objectStore("meta").get(q)), s = await n.objectStore("owners").openCursor();
      for (; s; ) {
        const u = _n(s.value);
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
  const o = he(e), s = await Me();
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
const ft = (e) => bt(e, !1), dt = (e) => bt(e, !0), Sn = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/, mn = /* @__PURE__ */ new Set(["history", "banks", "verify"]);
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
function lt(e) {
  return Number.isSafeInteger(e) && e >= 0;
}
function bn(e, n) {
  if (e === 202 && n.error === "MIGRATION_PENDING") {
    (Object.hasOwn(n, "token") || n.ok !== !1 || !Nn(n.migration)) && ae("INVALID_RESPONSE");
    const s = n.migration;
    return (s.status !== "running" || !mn.has(s.phase) || !lt(s.processed) || !lt(s.total) || s.processed > s.total || !Number.isSafeInteger(n.retryAfterMs) || n.retryAfterMs !== 750) && ae("INVALID_RESPONSE"), { state: "pending", migration: structuredClone(s), retryAfterMs: n.retryAfterMs };
  }
  if (e === 200 && n.ok === !0 && typeof n.token == "string" && Sn.test(n.token))
    return { state: "ready", token: n.token };
  (/* @__PURE__ */ new Set(["MIGRATION_UNCERTAIN", "MIGRATION_QUARANTINED", "ACCOUNT_DELETED", "UNAVAILABLE", "RATE_LIMITED", "AUTH_FAILED"])).has(n.error) && ae(n.error, { retryable: n.error === "UNAVAILABLE" || n.error === "RATE_LIMITED" }), ae("AUTH_FAILED");
}
const Ne = "qb_account_v2_session_v1", ce = "qb_account_v2_delete_ticket_v1", J = "qb_account_v2_local_cleanup_v1", ue = 2, xn = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/, xt = /^[0-9a-f]{64}$/, Dn = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, Dt = Dn, ht = /^dt1\.[0-9a-f]{64}\.[0-9a-f]{64}$/, At = 8, be = 32, yt = 3500, On = 3e4, Un = 3600;
class Ot extends Error {
  constructor(n) {
    super(n), this.name = "AccountV2Error", this.code = n;
  }
}
function i(e) {
  return new Ot(e);
}
function U(e, n) {
  if (!e || typeof e != "object" || Array.isArray(e)) return !1;
  const o = Object.keys(e);
  return o.length === n.length && n.every((s) => o.includes(s));
}
function Rn(e) {
  return U(e, ["ok", "accountId", "accountGeneration", "expiresAt"]) && e.ok === !0 && xt.test(e.accountId) && Dt.test(e.accountGeneration) && Number.isSafeInteger(e.expiresAt) && e.expiresAt > Date.now();
}
function Et(e) {
  return typeof e == "string" && xn.test(e);
}
function wt() {
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
function It(e) {
  return new Promise((n) => setTimeout(n, e));
}
function Pn(e = {}) {
  const n = e.enabled === !0, o = kn(e.apiBase || "/api", e.allowMirrorApi), s = e.fetchImpl || globalThis.fetch.bind(globalThis), u = e.migrationDelay || ((t) => new Promise((r) => setTimeout(r, t))), d = /* @__PURE__ */ new Set(), E = /* @__PURE__ */ new Set(), _ = /* @__PURE__ */ new Set();
  let y = 0, h = null, I = null, m = null, g = n ? "guest" : "off", F = "none", z = null, D = !1, H = null, Ae = null;
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
    return D = !0, r;
  }
  async function Ut() {
    D = !0;
    const t = Ve(), r = y;
    if (await gn(), l(r), t) {
      const f = t.version === 1 ? [{ owner: t.owner, status: t.status }] : t.entries;
      for (const w of f)
        await ft(w.owner ? { accountId: w.owner.accountId, accountGeneration: w.owner.accountGeneration } : null), l(r);
      if (globalThis.sessionStorage.getItem(J) !== JSON.stringify(t)) throw i("STALE_REQUEST");
      if (globalThis.sessionStorage.removeItem(J), globalThis.sessionStorage.getItem(J) !== null) throw i("STORAGE_UNAVAILABLE");
    }
    const a = await ut();
    if (l(r), D = a.length > 0, !E.size) return;
    for (const f of a)
      if (f.owner)
        try {
          for (const w of E)
            await w({ owner: { ...f.owner }, receipt: { ok: !0, status: "complete" }, cleanupRequired: !0 }), l(r);
          await dt(f.owner), l(r);
        } catch (w) {
          if (l(r), w?.code === "STALE_REQUEST") throw w;
        }
    const c = await ut();
    l(r), D = c.length > 0;
  }
  function b() {
    return {
      enabled: n,
      phase: g,
      epoch: y,
      owner: I ? { ...I } : null,
      pendingDeletion: !!m,
      deletionRecovery: F,
      deletionRecoveryError: z,
      cleanupRequired: D
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
      return Et(t) ? t : null;
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
    return (t?.version === 1 ? U(t, ["version", "ticket", "expiresAt", "deleteSent"]) : t?.version === ue && U(t, ["version", "ticket", "expiresAt", "deleteSent", "owner"]) && Ge(t.owner)) && typeof t.ticket == "string" && ht.test(t.ticket) && Number.isSafeInteger(t.expiresAt) && t.expiresAt > 0 && typeof t.deleteSent == "boolean";
  }
  function Ge(t) {
    return U(t, ["accountId", "accountGeneration", "expiresAt"]) && xt.test(t.accountId) && Dt.test(t.accountGeneration) && Number.isSafeInteger(t.expiresAt) && t.expiresAt > 0;
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
  function V() {
    const t = Ee();
    return t.state === "storage-error" ? t : we(t.raw);
  }
  function Qe(t, r) {
    if (r !== null && (l(r), t !== null && !L(t, r)))
      throw i("STALE_REQUEST");
  }
  function Pt(t) {
    l(t);
    const r = V();
    if (l(t), r.state !== "none")
      throw r.state === "valid" ? i("DELETE_PENDING") : i(r.error || "STALE_REQUEST");
  }
  function ve(t, r = null, a = null) {
    const c = te(t);
    try {
      globalThis.sessionStorage.setItem(ce, JSON.stringify(c));
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    Qe(r, a);
    const f = V();
    if (Qe(r, a), f.state !== "valid" || !W(f.journal, c)) throw i("STORAGE_UNAVAILABLE");
    return c;
  }
  function ne(t, r, a = t) {
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    const c = V();
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    if (c.state === "storage-error") throw i("STORAGE_UNAVAILABLE");
    if (c.state === "expired") throw i("DELETION_TICKET_EXPIRED");
    if (c.state !== "valid" || !W(c.journal, a)) throw i("STALE_REQUEST");
    return c.journal;
  }
  function Ct(t, r) {
    if (l(r), !L(t, r)) throw i("STALE_REQUEST");
    const a = V();
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
    const c = V();
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
    return ++y, re(), h = null, I = null, X(), m = null, g = "error", P("error", t), N(), i(t);
  }
  function $e(t, r) {
    l(r);
    const a = {
      version: t.version,
      ticket: t.ticket,
      expiresAt: t.expiresAt,
      deleteSent: t.deleteSent,
      epoch: r,
      owner: t.version === 2 ? { ...t.owner } : null
    };
    if (m = a, D = !a.owner || E.size === 0, g = "deleting", P("pending"), N(), !L(a, r)) throw i("STALE_REQUEST");
    return a;
  }
  function Ke(t) {
    const r = ++y;
    re(), h = null, I = null, X(), l(r);
    const a = V();
    if (a.state !== "valid" || !W(a.journal, t))
      throw l(r), Ie(a.error || "STALE_REQUEST");
    return $e(a.journal, r);
  }
  function Y() {
    if (m) throw i("DELETE_PENDING");
    const t = V();
    if (t.state !== "none")
      throw t.state === "valid" ? (Ke(t.journal), i("DELETE_PENDING")) : Ie(t.error);
  }
  function re() {
    _.forEach((t) => t.abort()), _.clear();
  }
  function Z(t = "guest") {
    const r = ++y;
    return re(), h = null, I = null, X(), g = t, N(), r;
  }
  function l(t) {
    if (t !== y) throw i("STALE_REQUEST");
  }
  async function K(t, r = {}, a = y) {
    l(a);
    const c = new AbortController();
    _.add(c);
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
    } catch (A) {
      throw a !== y || A?.name === "AbortError" ? i("STALE_REQUEST") : i("UNAVAILABLE");
    } finally {
      _.delete(c);
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
    if (l(r), !U(c, ["ok", "token"]) || c.ok !== !0 || !Et(c.token))
      throw i("AUTH_FAILED");
    return c.token;
  }
  async function Je(t, r) {
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
  async function Mt() {
    if (!n) return b();
    if (await Ut(), m) return oe();
    if (H && Ae === y) return H;
    const t = V();
    if (t.state !== "none") {
      if (t.state !== "valid") throw Ie(t.error);
      return Ke(t.journal), oe();
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
      throw g = "error", N(), f;
    }
    const c = Je(r, a).then((f) => (l(a), ye(r), h = r, I = f, g = "ready", N(), b())).catch((f) => {
      if (f?.code === "STALE_REQUEST") return b();
      throw l(a), h = null, I = null, f?.code === "AUTH_FAILED" && X(), g = f?.code === "AUTH_FAILED" ? "guest" : "error", N(), f;
    }).finally(() => {
      H === c && (H = null, Ae = null);
    });
    return H = c, Ae = a, c;
  }
  async function qe(t, r) {
    const a = await Je(t, r);
    return l(r), ye(t), h = t, I = a, g = "ready", N(), b();
  }
  async function Vt(t, r = () => {
  }) {
    if (!n) throw i("DISABLED");
    Y();
    const a = String(t || "").trim();
    if (a.length < 4 || a.length > 64) throw i("INVALID_INPUT");
    const c = Z("authenticating");
    try {
      let f = null;
      for (let w = 0; w < be; w += 1) {
        const A = await K("/v2/auth", { method: "POST", body: { action: "login", code: a } }, c);
        let O;
        try {
          O = await A.json();
        } catch {
          throw l(c), i("UNAVAILABLE");
        }
        l(c);
        let p;
        try {
          p = bn(A.status, O);
        } catch (C) {
          if (C?.code !== "RATE_LIMITED") throw C;
          const x = A.headers.get("Retry-After"), B = x && /^\d{1,4}$/.test(x) ? Math.min(Un, Math.max(1, Number(x))) : 5;
          if (w === be - 1) throw i("MIGRATION_PENDING", { migration: f, retryAfterMs: B * 1e3 });
          await u(Math.max(yt, B * 1e3)), l(c);
          continue;
        }
        if (p.state === "ready") return await qe(p.token, c);
        f = p.migration;
        try {
          r(structuredClone(f));
        } catch {
        }
        if (w === be - 1) throw i("MIGRATION_PENDING", { migration: f, retryAfterMs: p.retryAfterMs });
        await u(Math.min(On, Math.max(yt, p.retryAfterMs))), l(c);
      }
      throw i("MIGRATION_PENDING", { migration: f });
    } catch (f) {
      if (f?.code !== "STALE_REQUEST") {
        try {
          l(c);
        } catch {
          throw f;
        }
        g = f?.code === "AUTH_FAILED" ? "guest" : "error", N();
      }
      throw f;
    }
  }
  async function Gt(t, r) {
    if (!n) throw i("DISABLED");
    Y();
    const a = String(t || "").trim();
    if (a.length < 4 || a.length > 64 || typeof r != "function") throw i("INVALID_INPUT");
    const c = Z("authenticating");
    try {
      const f = wt(), w = await K("/v2/auth", {
        method: "POST",
        body: { action: "prepare-register", code: a, opId: f }
      }, c), A = await ee(w, [200], c);
      if (l(c), !U(A, ["ok", "intent", "expiresAt"]) || A.ok !== !0 || typeof A.intent != "string" || !/^ri1\.[0-9a-f]{64}$/.test(A.intent) || !Number.isSafeInteger(A.expiresAt) || A.expiresAt <= Date.now()) throw i("UNAVAILABLE");
      l(c);
      const O = await r();
      if (l(c), !O)
        return g = "guest", N(), { ...b(), cancelled: !0 };
      const p = await jt({ action: "register", code: a, opId: f, intent: A.intent }, c);
      return await qe(p, c);
    } catch (f) {
      if (f?.code !== "STALE_REQUEST") {
        try {
          l(c);
        } catch {
          throw f;
        }
        g = f?.code === "AUTH_FAILED" ? "guest" : "error", N();
      }
      throw f;
    }
  }
  function Qt() {
    return n && (Y(), Z("guest")), b();
  }
  async function vt(t) {
    if (!n || (Y(), !h || !I || typeof t != "function")) throw i("AUTH_FAILED");
    const r = y, a = h, c = { ...I };
    if (!await t()) return { ...b(), cancelled: !0 };
    if (l(r), h !== a || !I || I.accountId !== c.accountId || I.accountGeneration !== c.accountGeneration) throw i("STALE_REQUEST");
    const f = Z("deleting");
    try {
      const w = await K("/v2/account", {
        method: "POST",
        headers: { Authorization: `Bearer ${a}` },
        body: { action: "prepare-delete", opId: wt() }
      }, f), A = await ee(w, [200], f);
      if (l(f), !U(A, ["ok", "ticket", "expiresAt"]) || A.ok !== !0 || typeof A.ticket != "string" || !ht.test(A.ticket) || !Number.isSafeInteger(A.expiresAt) || A.expiresAt <= Date.now()) throw i("UNAVAILABLE");
      l(f), Pt(f);
      const O = ve({
        owner: c,
        ticket: A.ticket,
        expiresAt: A.expiresAt,
        deleteSent: !1
      }, null, f);
      return l(f), $e(O, f), oe();
    } catch (w) {
      if (w?.code === "STALE_REQUEST") throw w;
      try {
        l(f);
      } catch {
        throw w;
      }
      throw g = "error", P("error", w?.code || "UNAVAILABLE"), N(), w;
    }
  }
  let j = null;
  function L(t, r) {
    return y === r && m === t && t.epoch === r;
  }
  function G(t) {
    if (l(t.epoch), g !== "error" || F !== "error" || z !== t.code || m !== t.deletion)
      throw i("STALE_REQUEST");
    if (j !== null) throw i("DELETE_PENDING");
  }
  function Fe(t) {
    G(t);
    const r = Ee();
    if (G(t), r.state === "storage-error") throw i("STORAGE_UNAVAILABLE");
    return r.raw;
  }
  function ze(t, r) {
    const a = we(r);
    if (a.state === "valid") throw i("DELETE_PENDING");
    const c = t.code === "INVALID_DELETION_JOURNAL" ? "invalid" : t.code === "DELETION_TICKET_EXPIRED" ? "expired" : "none";
    if (a.state !== c) throw i("STALE_REQUEST");
    return a;
  }
  function He(t, r) {
    return G(t), g = "error", P("error", r), N(), i(r);
  }
  function Xe(t) {
    G(t);
    const r = ++y;
    if (re(), h = null, I = null, X(), y !== r) throw i("STALE_REQUEST");
    return m = null, g = "guest", P(), N(), b();
  }
  function Q(t, r, a) {
    return L(t, r) && (g = "error", P("error", a?.code || "UNAVAILABLE"), N()), a;
  }
  async function $t(t, r) {
    let a = 0;
    for (; m === t && t.epoch === r && a < At && t.expiresAt > Date.now(); ) {
      l(r);
      let c;
      try {
        c = Ct(t, r);
      } catch (A) {
        throw A?.code === "STALE_REQUEST" ? A : Q(t, r, A);
      }
      const f = t.deleteSent ? "status" : "delete";
      a += 1;
      let w;
      try {
        const A = await K("/v2/account", {
          method: "POST",
          body: { action: f, ticket: t.ticket }
        }, r);
        if (w = await ee(A, [200, 202], r), l(r), !L(t, r)) throw i("STALE_REQUEST");
        if (!U(w, ["ok", "status"]) || w.ok !== !0 || !["pending", "complete"].includes(w.status)) throw i("UNAVAILABLE");
        ne(t, r, c);
      } catch (A) {
        if (A?.code === "STALE_REQUEST") throw A;
        if (Q(t, r, A), f === "delete" && A?.code === "UNAVAILABLE" && a < At) {
          await It(250);
          continue;
        }
        throw A;
      }
      if (w.status === "complete") {
        if (!L(t, r)) throw i("STALE_REQUEST");
        const A = t.owner ? { accountId: t.owner.accountId, accountGeneration: t.owner.accountGeneration } : null;
        D = !0;
        try {
          await ft(A), l(r);
        } catch (p) {
          throw p?.code === "STALE_REQUEST" || !L(t, r) ? i("STALE_REQUEST") : Q(t, r, p);
        }
        if (!L(t, r)) throw i("STALE_REQUEST");
        D = !t.owner || E.size === 0;
        const O = { owner: t.owner ? { ...t.owner } : null, receipt: { ok: !0, status: "complete" }, cleanupRequired: D };
        try {
          for (const p of E)
            if (await p(structuredClone(O)), !L(t, r)) throw i("STALE_REQUEST");
        } catch (p) {
          if (D = !0, p?.code === "STALE_REQUEST" || !L(t, r)) throw i("STALE_REQUEST");
        }
        if (!D) {
          D = !0;
          try {
            await dt(A), l(r), D = !1;
          } catch (p) {
            throw p?.code === "STALE_REQUEST" || !L(t, r) ? i("STALE_REQUEST") : Q(t, r, p);
          }
        }
        if (D)
          try {
            const p = Ve(), C = { owner: t.owner ? { ...t.owner } : null, status: "cleanup-required" }, x = p ? p.version === 1 ? [{ owner: p.owner, status: p.status }] : p.entries : [];
            if (x.some((se) => se.owner?.accountId === C.owner?.accountId && se.owner?.accountGeneration === C.owner?.accountGeneration) || x.push(C), x.length > 100) throw i("LOCAL_CLEANUP_QUEUE_FULL");
            const B = JSON.stringify(x.length === 1 && !p ? { version: 1, ...C } : { version: 2, entries: x });
            if (globalThis.sessionStorage.setItem(J, B), globalThis.sessionStorage.getItem(J) !== B) throw i("STORAGE_UNAVAILABLE");
          } catch (p) {
            throw Q(t, r, p?.code ? p : i("STORAGE_UNAVAILABLE"));
          }
        try {
          Bt(t, r, c);
        } catch (p) {
          throw p?.code === "STALE_REQUEST" ? p : Q(t, r, p);
        }
        return m = null, P(), I || (g = "deleted"), N(), b();
      }
      if (!L(t, r)) throw i("STALE_REQUEST");
      if (!t.deleteSent) {
        try {
          ne(t, r, c), ve({ ...t, deleteSent: !0 }, t, r), ne(t, r, { ...c, deleteSent: !0 });
        } catch (A) {
          throw A?.code === "STALE_REQUEST" ? A : Q(t, r, A);
        }
        if (l(r), !L(t, r)) throw i("STALE_REQUEST");
        t.deleteSent = !0;
      }
      g = "deleting", P("pending"), N(), await It(250);
    }
    throw L(t, r) ? (g = "error", P("error", t.expiresAt <= Date.now() ? "DELETION_TICKET_EXPIRED" : "UNAVAILABLE"), N(), i(z)) : i("STALE_REQUEST");
  }
  function oe() {
    if (!m) return Promise.resolve(b());
    if (m.epoch !== y) return Promise.reject(i("STALE_REQUEST"));
    if (j && j.deletion === m && j.epoch === y)
      return j.promise;
    const t = m, r = y;
    let a;
    return a = Promise.resolve().then(() => $t(t, r)).finally(() => {
      j && j.promise === a && (j = null);
    }), j = { deletion: t, epoch: r, promise: a }, g = "deleting", N(), a;
  }
  async function Kt(t) {
    if (!n) return b();
    if (typeof t != "function") throw i("INVALID_INPUT");
    const r = {
      epoch: y,
      deletion: m,
      code: z
    };
    if (!["INVALID_DELETION_JOURNAL", "DELETION_TICKET_EXPIRED", "DELETION_JOURNAL_CLEAR_UNCERTAIN"].includes(r.code))
      throw i("STALE_REQUEST");
    const a = Fe(r);
    if (ze(r, a), !await t()) return { ...b(), cancelled: !0 };
    G(r);
    const f = Fe(r), w = ze(r, f);
    if (f !== a) throw i("STALE_REQUEST");
    if (r.code === "DELETION_JOURNAL_CLEAR_UNCERTAIN") {
      if (w.state !== "none") throw i("STALE_REQUEST");
      return Xe(r);
    }
    try {
      globalThis.sessionStorage.removeItem(ce);
    } catch {
      throw i("STORAGE_UNAVAILABLE");
    }
    G(r);
    const A = Ee();
    if (G(r), A.state === "storage-error")
      throw He(r, "DELETION_JOURNAL_CLEAR_UNCERTAIN");
    if (we(A.raw).state === "none") return Xe(r);
    throw He(r, "STALE_REQUEST");
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
    if (!n || g !== "ready" || !I || !h || I.expiresAt <= Date.now()) throw i("AUTH_FAILED");
    if (Y(), !t || !U(t, Object.hasOwn(t, "body") ? ["path", "method", "body"] : ["path", "method"])) throw i("INVALID_INPUT");
    const r = new URL(String(t.path), "http://bounded.invalid");
    if (r.origin !== "http://bounded.invalid" || !t.path.startsWith("/v2/") || r.hash) throw i("INVALID_INPUT");
    const c = {
      "/v2/sync/push": { methods: ["POST"], keys: [], requestMax: 256 * 1024, responseMax: 256 * 1024 },
      "/v2/sync/pull": { methods: ["GET"], keys: ["after", "until", "limit"], responseMax: 512 * 1024 },
      "/v2/content/chunks": { methods: ["GET", "PUT"], keys: ["contentDigest", "chunkIndex"], requestMax: 512 * 1024, responseMax: 512 * 1024 },
      "/v2/content/manifests": { methods: ["POST", "GET"], keys: ["contentDigest"], requestMax: 128 * 1024, responseMax: 129 * 1024 },
      "/v2/export/start": { methods: ["POST"], keys: [], requestMax: 2048, responseMax: 8 * 1024 },
      "/v2/export/reset": { methods: ["POST"], keys: [], requestMax: 2048, responseMax: 2048 },
      "/v2/export/page": { methods: ["GET"], keys: ["exportId", "section", "after", "limit"], responseMax: 512 * 1024 },
      "/v2/export/chunk": { methods: ["GET"], keys: ["exportId", "contentDigest", "chunkIndex"], responseMax: 512 * 1024 },
      "/v2/legacy/history": { methods: ["GET"], keys: ["limit", "cursor", "id"], responseMax: 409600 },
      "/v2/legacy/banks": { methods: ["GET"], keys: ["limit", "cursor", "id", "chunkIndex", "part"], responseMax: 256 * 1024 }
    }[r.pathname], f = [...r.searchParams.keys()];
    if (!c || !c.methods.includes(t.method) || f.some((R) => !c.keys.includes(R)) || new Set(f).size !== f.length || t.method === "GET" && Object.hasOwn(t, "body")) throw i("INVALID_INPUT");
    let w;
    const A = new Headers({ Accept: "application/json" });
    if (Object.hasOwn(t, "body")) {
      if (r.pathname === "/v2/content/chunks") {
        if (!(t.body instanceof Uint8Array)) throw i("INVALID_INPUT");
        w = new Uint8Array(t.body), A.set("Content-Type", "application/octet-stream");
      } else {
        try {
          w = de(t.body);
        } catch {
          throw i("INVALID_INPUT");
        }
        A.set("Content-Type", "application/json");
      }
      if (!c.requestMax || w.byteLength > c.requestMax) throw i("BODY_TOO_LARGE");
    }
    const O = y, p = { ...I }, C = h, x = () => {
      if (l(O), g !== "ready" || h !== C || !I || I.accountId !== p.accountId || I.accountGeneration !== p.accountGeneration) throw i("STALE_REQUEST");
    };
    x(), A.set("Authorization", `Bearer ${C}`);
    const B = new AbortController();
    _.add(B);
    const se = setTimeout(() => B.abort(), 3e4);
    try {
      const R = await s(`${o}${r.pathname}${r.search}`, { method: t.method, headers: A, body: w, credentials: "omit", cache: "no-store", redirect: "error", signal: B.signal });
      x();
      const ie = R.body?.getReader();
      if (!ie) throw i("UNAVAILABLE");
      let pe = 0;
      const We = [], zt = Math.min(512 * 1024, c.responseMax || 512 * 1024);
      try {
        for (; ; ) {
          const M = await ie.read();
          if (x(), M.done) break;
          if (pe += M.value.length, pe > zt)
            throw await ie.cancel(), i("RESPONSE_TOO_LARGE");
          We.push(M.value);
        }
      } finally {
        ie.releaseLock();
      }
      const Te = new Uint8Array(pe);
      let Ye = 0;
      for (const M of We)
        Te.set(M, Ye), Ye += M.length;
      x();
      let _e;
      const ge = R.ok && ["/v2/legacy/history", "/v2/legacy/banks"].includes(r.pathname) && r.searchParams.has("id");
      if (R.ok && (["/v2/content/chunks", "/v2/export/chunk"].includes(r.pathname) || ge) && t.method === "GET") _e = Te;
      else
        try {
          _e = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(Te));
        } catch {
          throw i("UNAVAILABLE");
        }
      x();
      const Se = R.headers.get("Retry-After"), Ze = {};
      if (ge) for (const M of ["content-type", "content-length", "x-legacy-source-key", "x-legacy-source-sha256", "x-legacy-byte-length", "x-legacy-chunk-sha256", "x-legacy-chunk-index", "x-legacy-chunk-count"]) {
        const et = R.headers.get(M);
        et !== null && (Ze[M] = et);
      }
      return { status: R.status, body: _e, ...ge ? { headers: Ze } : {}, retryAfter: Se && /^[1-9][0-9]{0,3}$/.test(Se) ? Number(Se) : null, epoch: O, owner: p };
    } catch (R) {
      throw O !== y ? i("STALE_REQUEST") : R instanceof Ot ? R : i("UNAVAILABLE");
    } finally {
      clearTimeout(se), _.delete(B);
    }
  }
  return Object.freeze({
    enabled: n,
    snapshot: b,
    subscribe: Jt,
    resume: Mt,
    login: Vt,
    register: Gt,
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
  Ot as AccountV2Error,
  Pn as createAccountV2Controller
};
