import { openDB } from "idb";
import {
  APP_DATA_STORES,
  canonicalBytes,
  validateActiveProfilePointer,
  validateProfileRegistry,
  validateVerificationJournal
} from "../../domain/app-data/index.js";
import { storageError } from "../idb/transaction.js";

export const CONTROL_SCHEMA_VERSION = 1;
export const CONTROL_STORES = Object.freeze(["profiles", "meta"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWN = Object.prototype.hasOwnProperty;

/** @param {string} code @param {string} message @param {unknown} [cause] */
export function profileError(code, message, cause) { return storageError(code, message, cause); }

/** @param {unknown} value @param {string} label */
function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) {
    throw profileError("CORRUPT", `${label} must be a plain data record`);
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !OWN.call(descriptor, "value")) throw profileError("CORRUPT", `${label}.${name} must be a data property`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {string[]} required @param {string[]} optional @param {string} label */
function exactFields(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !OWN.call(value, key))) {
    throw profileError("CORRUPT", `${label} has an unsupported shape`);
  }
}

/** @param {unknown} value @returns {{ownerKind:"guest",guestId:string}|{ownerKind:"account",accountId:string,accountGeneration:string}} */
export function snapshotOwner(value) {
  const owner = plain(value, "owner");
  if (owner.ownerKind === "guest") {
    exactFields(owner, ["ownerKind", "guestId"], [], "owner");
    if (!UUID_V4.test(/** @type {string} */ (owner.guestId))) throw profileError("INVALID", "guestId must be a UUIDv4");
    return Object.freeze({ ownerKind: "guest", guestId: /** @type {string} */ (owner.guestId) });
  }
  if (owner.ownerKind === "account") {
    exactFields(owner, ["ownerKind", "accountId", "accountGeneration"], [], "owner");
    if (typeof owner.accountId !== "string" || owner.accountId.length === 0 || new TextEncoder().encode(owner.accountId).byteLength > 512 || !UUID_V4.test(/** @type {string} */ (owner.accountGeneration))) {
      throw profileError("INVALID", "account owner must have a bounded accountId and accountGeneration");
    }
    return Object.freeze({ ownerKind: "account", accountId: owner.accountId, accountGeneration: owner.accountGeneration });
  }
  throw profileError("INVALID", "ownerKind must be guest or account");
}

/** @param {unknown} left @param {unknown} right */
export function sameOwner(left, right) {
  return left?.ownerKind === right?.ownerKind && (left?.ownerKind === "guest"
    ? left.guestId === right.guestId
    : left?.accountId === right?.accountId && left?.accountGeneration === right?.accountGeneration);
}

/** @param {unknown} controlId */
export function controlDbName(controlId, namespace = "test") {
  if (!UUID_V4.test(/** @type {string} */ (controlId))) throw profileError("INVALID", "controlId must be a UUIDv4");
  if (!["test", "production"].includes(namespace)) throw profileError("INVALID", "invalid profile namespace");
  return `${namespace === "production" ? "qb-v2" : "qb-b1a-test"}-control-${controlId}`;
}

/** @param {unknown} dbName */
export function assertBusinessDbName(dbName) {
  const prefix = typeof dbName === "string" && dbName.startsWith("qb-v2-business-") ? "qb-v2-business-" : "qb-b1a-test-business-";
  if (typeof dbName !== "string" || !dbName.startsWith(prefix) || !UUID_V4.test(dbName.slice(prefix.length))) throw profileError("CORRUPT", "business dbName is not a generated profile name");
  return dbName;
}

/** @param {unknown} value */
export function cloneData(value) { return JSON.parse(JSON.stringify(value)); }

/** @param {unknown} value */
export function stableData(value) { return new TextDecoder().decode(canonicalBytes(value)); }

/** @param {IDBDatabase} database */
export async function assertControlSchema(database) {
  if (database.version !== CONTROL_SCHEMA_VERSION) throw profileError("SCHEMA_VERSION_UNSUPPORTED", "control database version is unsupported");
  const names = Array.from(database.objectStoreNames);
  if (names.length !== 2 || CONTROL_STORES.some((name) => !database.objectStoreNames.contains(name))) throw profileError("SCHEMA_MISMATCH", "control stores are not exact");
  let tx;
  try {
    tx = database.transaction(CONTROL_STORES, "readonly");
    for (const name of CONTROL_STORES) {
      const store = tx.objectStore(name);
      if (store.keyPath !== (name === "profiles" ? "profileId" : "key") || store.autoIncrement || store.indexNames.length) throw profileError("SCHEMA_MISMATCH", `${name} schema is not exact`);
    }
    await tx.done;
  } catch (cause) {
    try { tx?.abort(); } catch { /* settled transaction */ }
    await Promise.allSettled([tx?.done]);
    if (cause?.code) throw cause;
    throw profileError("SCHEMA_MISMATCH", "unable to inspect control schema", cause);
  }
}

/** @param {unknown} profile @param {unknown} journal @param {{allowStaged?:boolean, verifyCompleted?:boolean}} [options] */
export function validateProfileJournalPair(profile, journal, options = {}) {
  let checkedProfile;
  try { checkedProfile = validateProfileRegistry(profile); } catch (cause) { throw profileError("CORRUPT", "stored profile is invalid", cause); }
  const checkedJournal = plain(journal, "fresh journal");
  const phase = checkedJournal.phase;
  const base = ["key", "kind", "profileId", "jobId", "dbName", "owner", "phase"];
  const optional = ["failure", "manifest", "verification", "cleanupCommitment"];
  exactFields(checkedJournal, base, optional, "fresh journal");
  if (checkedJournal.key !== `fresh:${checkedProfile.profileId}` || !["b1a-fresh-creation", "qb-v2-staged-restore"].includes(checkedJournal.kind) || checkedJournal.profileId !== checkedProfile.profileId || !UUID_V4.test(checkedJournal.jobId) || checkedJournal.dbName !== checkedProfile.dbName) throw profileError("CORRUPT", "fresh journal identity disagrees with profile");
  const owner = snapshotOwner(checkedJournal.owner);
  if (checkedProfile.ownerKind !== owner.ownerKind || (owner.ownerKind === "account" && (checkedProfile.accountId !== owner.accountId || checkedProfile.accountGeneration !== owner.accountGeneration))) throw profileError("CORRUPT", "profile and journal owner disagree");
  assertBusinessDbName(checkedProfile.dbName);
  if (!["allocated", "creating", "created", "completed", "quarantined"].includes(/** @type {string} */ (phase))) throw profileError("CORRUPT", "fresh journal phase is invalid");
  if (checkedJournal.failure !== undefined) validateFailure(checkedJournal.failure);
  if (phase === "completed") {
    if (checkedProfile.state !== "ready" || checkedJournal.manifest === undefined || checkedJournal.verification === undefined) throw profileError("CORRUPT", "completed journal must pair with a ready profile");
    const manifest = validateManifest(checkedJournal.manifest);
    if(checkedJournal.cleanupCommitment!==undefined){validateCleanupCommitment(checkedJournal.cleanupCommitment);if(manifest.format!=='qb-v2-native-manifest-v2')throw profileError('CORRUPT','cleanup commitment requires native V2 terminal');}
    if ((checkedJournal.kind === "qb-v2-staged-restore") !== (["qb-v2-restored-manifest-v1", "qb-v2-native-manifest-v2"].includes(manifest.format))) throw profileError("CORRUPT", "journal and manifest kinds differ");
    let verification;
    try { verification = validateVerificationJournal(checkedJournal.verification); } catch (cause) { throw profileError("CORRUPT", "completed journal verification is invalid", cause); }
    assertIsoVerifiedAt(verification.verifiedAt);
    const profileVerification = checkedProfile.verification;
    if (checkedProfile.schemaVersion !== 1 || checkedProfile.importJobId !== checkedJournal.jobId || !profileVerification || profileVerification.jobId !== verification.jobId || profileVerification.schemaVersion !== verification.schemaVersion || profileVerification.contentDigest !== verification.contentDigest || profileVerification.recordCount !== verification.recordCount || profileVerification.verifiedAt !== verification.verifiedAt || checkedProfile.lastVerifiedAt !== verification.verifiedAt || verification.jobId !== checkedJournal.jobId || verification.schemaVersion !== 1 || verification.recordCount !== manifest.stores.reduce((sum, row) => sum + row.recordCount, 0)) throw profileError("CORRUPT", "completed journal verification disagrees with profile");
    return { profile: checkedProfile, journal: checkedJournal, owner, phase, manifest, verification };
  }
  const expectedState = phase === "quarantined" ? "quarantined" : "staged";
  if (checkedJournal.manifest !== undefined || checkedJournal.verification !== undefined || checkedJournal.cleanupCommitment!==undefined || checkedProfile.state !== expectedState || checkedProfile.importJobId !== checkedJournal.jobId || !options.allowStaged) throw profileError("CORRUPT", "non-completed journal/profile pair is invalid");
  return { profile: checkedProfile, journal: checkedJournal, owner, phase, manifest: null, verification: null };
}

/** Reserved control records, never ordinary nineteen-store backup facts. */
export function validateCleanupCommitment(value){const v=plain(value,'cleanup commitment');exactFields(v,['format','jobId','bindingDigest','initialInventory'],['prepareAnchor'],'cleanup commitment');if(v.format!=='qb-s1-cleanup-commitment-v1'||!UUID_V4.test(v.jobId)||! /^[0-9a-f]{64}$/.test(v.bindingDigest))throw profileError('CORRUPT','cleanup commitment identity');if(v.initialInventory!==null)validateCleanupInventory(v.initialInventory);if(v.prepareAnchor!==undefined){const a=validateCleanupPrepareAnchor(v.prepareAnchor);if(a.jobId!==v.jobId||a.bindingDigest!==v.bindingDigest||v.initialInventory!==null&&a.inventoryRoot!==v.initialInventory.sha256)throw profileError('CORRUPT','prepare anchor differs from terminal commitment');}return v;}
export function validateCleanupPrepareAnchor(value){const a=plain(value,'cleanup prepare anchor');exactFields(a,['format','jobId','bindingDigest','inventoryRoot'],[],'cleanup prepare anchor');if(a.format!=='qb-s1-cleanup-prepare-anchor-v1'||!UUID_V4.test(a.jobId)||![a.bindingDigest,a.inventoryRoot].every(x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)))throw profileError('CORRUPT','prepare anchor');return a;}
export function validateCleanupPrepare(value){const m=plain(value,'cleanup prepare marker');exactFields(m,['key','format','jobId','phase','job','inventory','progress','targetProfile','targetJournal'],[],'cleanup prepare marker');if(m.format!=='qb-s1-cleanup-prepare-v1'||!UUID_V4.test(m.jobId)||m.key!==`cleanup-prepare:${m.jobId}`||!['prepared','terminal-referenced','orphan-cleaning'].includes(m.phase)||canonicalBytes(m).length>16384)throw profileError('CORRUPT','prepare marker');const job=validateCleanupJob(m.job),inventory=validateCleanupInventory(m.inventory),target=validateProfileJournalPair(m.targetProfile,m.targetJournal,{allowStaged:true});if(job.jobId!==m.jobId||job.inventory!==null||!Number.isSafeInteger(m.progress)||m.progress<0||m.progress>inventory.frameCount||target.profile.profileId!==job.binding.targetProfileId||target.profile.dbName!==job.binding.targetDbName||target.journal.jobId!==job.binding.targetJobId||!sameOwner(target.owner,job.binding.owner))throw profileError('CORRUPT','prepare allocation/progress');if(m.phase==='terminal-referenced'){const c=validateCleanupCommitment(target.journal.cleanupCommitment);if(target.phase!=='completed'||target.manifest.format!=='qb-v2-native-manifest-v2'||c.jobId!==m.jobId||c.bindingDigest!==job.bindingDigest||c.prepareAnchor?.inventoryRoot!==inventory.sha256)throw profileError('CORRUPT','terminal prepare marker');}else if(target.phase!=='created'||job.phase!=='prepared')throw profileError('CORRUPT','orphan must be an inert created allocation');return m;}
export function validateCleanupInventory(value){const v=plain(value,'cleanup inventory');exactFields(v,['frameCount','recordCount','bytes','encodedBytes','sha256','frames'],[],'cleanup inventory');if(!Number.isSafeInteger(v.frameCount)||v.frameCount<1||v.frameCount>32||!Number.isSafeInteger(v.recordCount)||v.recordCount<0||v.recordCount>200000||!Number.isSafeInteger(v.bytes)||v.bytes<0||v.bytes>8*1024*1024||!Number.isSafeInteger(v.encodedBytes)||v.encodedBytes<0||v.encodedBytes>8*1024*1024||! /^[0-9a-f]{64}$/.test(v.sha256)||!Array.isArray(v.frames)||v.frames.length!==v.frameCount)throw profileError('CORRUPT','cleanup inventory budget');let count=0,bytes=0;for(let index=0;index<v.frames.length;index++){const f=plain(v.frames[index],'cleanup frame descriptor');exactFields(f,['index','count','bytes','sha256'],[],'cleanup frame descriptor');if(f.index!==index||!Number.isSafeInteger(f.count)||f.count<0||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>512*1024||! /^[0-9a-f]{64}$/.test(f.sha256))throw profileError('CORRUPT','cleanup descriptor');count+=f.count;bytes+=f.bytes;}if(count!==v.recordCount||bytes!==v.encodedBytes)throw profileError('CORRUPT','cleanup descriptor aggregate');return v;}
export function validateCleanupJob(value){const v=plain(value,'cleanup job');exactFields(v,['key','format','jobId','phase','binding','bindingDigest','inventory'],['error','completedSource','framesCleaned'],'cleanup job');if(v.format!=='qb-s1-cleanup-job-v1'||!UUID_V4.test(v.jobId)||v.key!==`cleanup:${v.jobId}`||!['prepared','committed','complete'].includes(v.phase)||! /^[0-9a-f]{64}$/.test(v.bindingDigest)||canonicalBytes(v).length>16384)throw profileError('CORRUPT','cleanup job header');if(v.error!==undefined&&(typeof v.error!=='string'||! /^[A-Z0-9_]{1,80}$/.test(v.error)))throw profileError('CORRUPT','cleanup error code');if(v.inventory!==null)validateCleanupInventory(v.inventory);if((v.phase==='complete')!==(v.completedSource!==undefined)||(v.phase==='complete')!==(typeof v.framesCleaned==='boolean'))throw profileError('CORRUPT','cleanup completion pair/frame state required');
 if(v.phase!=='complete'&&v.framesCleaned!==undefined)throw profileError('CORRUPT','premature frame completion state');
 const b=plain(v.binding,'cleanup binding');exactFields(b,['owner','sourceProfile','sourceJournal','migrationJournal','metadata','originalProfileId','originalDbName','originalPointer','finalPointer','targetProfileId','targetJobId','targetDbName','targetContentDigest'],[],'cleanup binding');snapshotOwner(b.owner);assertBusinessDbName(b.originalDbName);assertBusinessDbName(b.targetDbName);validateActiveProfilePointer(b.originalPointer);validateActiveProfilePointer(b.finalPointer);if(!UUID_V4.test(b.originalProfileId)||!UUID_V4.test(b.targetProfileId)||!UUID_V4.test(b.targetJobId)||! /^[0-9a-f]{64}$/.test(b.targetContentDigest)||b.originalPointer.activeProfileId!==b.originalProfileId||b.finalPointer.activeProfileId!==b.targetProfileId||b.finalPointer.activationRevision!==b.originalPointer.activationRevision+1)throw profileError('CORRUPT','cleanup control identities');
 const source=validateProfileJournalPair(b.sourceProfile,b.sourceJournal,{allowStaged:true});if(source.phase!=='created'||!sameOwner(source.owner,b.owner)||source.profile.profileId===b.originalProfileId||source.profile.profileId===b.targetProfileId||source.profile.dbName===b.originalDbName||source.profile.dbName===b.targetDbName)throw profileError('CORRUPT','cleanup source allocation');
 const m=plain(b.metadata,'cleanup source metadata');exactFields(m,['owner','sourceProfileId','stageProfileId','stageId','originalPointer','checkpoint','checkpointDigest','context','cursorReset'],[],'cleanup source metadata');if(!sameOwner(m.owner,b.owner)||m.stageProfileId!==source.profile.profileId||m.sourceProfileId!==b.originalProfileId||!UUID_V4.test(m.stageId)||! /^[0-9a-f]{64}$/.test(m.checkpointDigest)||stableData(m.originalPointer)!==stableData(b.originalPointer))throw profileError('CORRUPT','cleanup metadata binding');if(v.completedSource!==undefined){const c=plain(v.completedSource,'cleaned source');exactFields(c,['profile','journal'],[],'cleaned source');const pair=validateProfileJournalPair(c.profile,c.journal,{allowStaged:true});if(pair.phase!=='quarantined'||pair.journal.failure?.code!=='CLOUD_SOURCE_CLEANED'||pair.profile.profileId!==source.profile.profileId||pair.profile.dbName!==source.profile.dbName||pair.journal.jobId!==source.journal.jobId||!sameOwner(pair.owner,b.owner))throw profileError('CORRUPT','cleaned source differs');}return v;
}
export function validateCleanupFrame(value){const v=plain(value,'cleanup frame');exactFields(v,['key','format','jobId','index','entries'],[],'cleanup frame');if(v.format!=='qb-s1-cleanup-frame-v1'||!UUID_V4.test(v.jobId)||!Number.isSafeInteger(v.index)||v.index<0||v.index>=32||v.key!==`cleanup-frame:${v.jobId}:${String(v.index).padStart(6,'0')}`||!Array.isArray(v.entries)||canonicalBytes(v).length>512*1024)throw profileError('CORRUPT','cleanup frame header');for(const raw of v.entries){const e=plain(raw,'cleanup entry');exactFields(e,['store','key','sha256'],[],'cleanup entry');if(!['content_chunks','import_receipts','migration_journal'].includes(e.store)||! /^[0-9a-f]{64}$/.test(e.sha256))throw profileError('CORRUPT','cleanup entry identity');if(e.store==='content_chunks'){if(!Array.isArray(e.key)||e.key.length!==2||! /^[0-9a-f]{64}$/.test(e.key[0])||!Number.isSafeInteger(e.key[1])||e.key[1]<0)throw profileError('CORRUPT','cleanup chunk key');}else if(e.store==='import_receipts'){if(!Array.isArray(e.key)||e.key.length!==2||e.key.some(x=>typeof x!=='string'||new TextEncoder().encode(x).length>1024))throw profileError('CORRUPT','cleanup receipt key');}else if(!UUID_V4.test(e.key))throw profileError('CORRUPT','cleanup journal key');}return v;}

/** @param {unknown} value */
function validateFailure(value) {
  const failure = plain(value, "fresh journal.failure");
  exactFields(failure, ["phase", "code", "observedAt"], [], "fresh journal.failure");
  if (!["create", "inspect", "finalize"].includes(/** @type {string} */ (failure.phase) || "") || typeof failure.code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(failure.code) || typeof failure.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failure.observedAt) || !Number.isFinite(Date.parse(failure.observedAt)) || new Date(failure.observedAt).toISOString() !== failure.observedAt) throw profileError("CORRUPT", "fresh journal.failure is invalid");
}

/** @param {unknown} value */
function assertIsoVerifiedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw profileError("CORRUPT", "completed verification timestamp is invalid");
  }
  return value;
}

/** @param {unknown} value */
export function validateManifest(value) {
  const manifest = plain(value, "manifest");
  const native = manifest.format === "qb-v2-native-manifest-v2";
  exactFields(manifest, native ? ["format", "businessSchemaVersion", "keyOrder", "rowEncoding", "stores"] : ["format", "businessSchemaVersion", "stores"], [], "manifest");
  const expected = Object.keys(APP_DATA_STORES).filter(name => manifest.businessSchemaVersion !== 1 || name !== 'history_snapshots').sort();
  const restored = native || manifest.format === "qb-v2-restored-manifest-v1";
  if (native && (manifest.keyOrder !== "indexeddb-primary-key-v1" || manifest.rowEncoding !== "canonical-ndjson-v1")) throw profileError("CORRUPT", "native manifest encoding is invalid");
  if ((!restored && manifest.format !== "qb-b1a-fresh-manifest-v1") || ![1,2].includes(manifest.businessSchemaVersion) || !Array.isArray(manifest.stores) || manifest.stores.length !== expected.length) throw profileError("CORRUPT", "fresh manifest header is invalid");
  manifest.stores.forEach((entry, index) => {
    const row = plain(entry, `manifest.stores[${index}]`);
    exactFields(row, restored ? ["name", "recordCount", "sha256"] : ["name", "recordCount"], [], `manifest.stores[${index}]`);
    if (row.name !== expected[index] || !Number.isSafeInteger(row.recordCount) || row.recordCount < 0 || (!restored && row.recordCount !== 0) || (restored && !/^[0-9a-f]{64}$/.test(row.sha256))) throw profileError("CORRUPT", "fresh manifest store counts are invalid");
  });
  return manifest;
}

/** @param {{ dbName:string, openMode:"create"|"existing", blockedTimeoutMs:number, signal?:AbortSignal }} options */
export async function openControlDatabase(options) {
  const { dbName, openMode, blockedTimeoutMs, signal } = options;
  if (!Number.isSafeInteger(blockedTimeoutMs) || blockedTimeoutMs < 1 || blockedTimeoutMs > 2_147_483_647) throw profileError("INVALID", "blockedTimeoutMs must be a bounded positive safe integer");
  if (signal?.aborted) throw profileError("CLOSED", "control open was cancelled");
  let created = false;
  let cancelled = false;
  let upgradeFailure;
  let opening;
  try {
    opening = openDB(dbName, CONTROL_SCHEMA_VERSION, {
      upgrade(db, oldVersion, newVersion, tx) {
        tx.done.catch(() => {});
        if (cancelled || oldVersion !== 0 || newVersion !== CONTROL_SCHEMA_VERSION || openMode !== "create") {
          upgradeFailure = cancelled
            ? profileError("CLOSED", "control open was cancelled or timed out")
            : profileError(oldVersion === 0 ? "SCHEMA_MISMATCH" : "SCHEMA_VERSION_UNSUPPORTED", "control open mode/schema does not permit upgrade");
          tx.abort();
          return;
        }
        created = true;
        db.createObjectStore("profiles", { keyPath: "profileId", autoIncrement: false });
        db.createObjectStore("meta", { keyPath: "key", autoIncrement: false });
      }
    });
  } catch (cause) {
    throw profileError("STORAGE_UNAVAILABLE", "unable to start control open", cause);
  }
  let timer;
  let remove;
  const cancelledOpen = new Promise((_, reject) => {
    const fail = () => {
      cancelled = true;
      reject(profileError("CLOSED", "control open was cancelled or timed out"));
    };
    timer = setTimeout(fail, blockedTimeoutMs);
    signal?.addEventListener("abort", fail, { once: true });
    remove = () => signal?.removeEventListener("abort", fail);
  });
  opening.then((late) => { if (cancelled) late.close(); }, () => {});
  let db;
  try {
    db = await Promise.race([opening, cancelledOpen]);
    if (upgradeFailure) throw upgradeFailure;
    if (openMode === "create" && !created) throw profileError("DB_ALREADY_EXISTS", "control create will not attach to an existing database");
    await assertControlSchema(db);
    if (cancelled || signal?.aborted) throw profileError("CLOSED", "control open was cancelled or timed out");
    return db;
  } catch (cause) {
    db?.close();
    if (upgradeFailure) throw upgradeFailure;
    if (cause?.code) throw cause;
    if (cause?.name === "VersionError") throw profileError("SCHEMA_VERSION_UNSUPPORTED", "control database version is newer than this implementation", cause);
    throw profileError("STORAGE_UNAVAILABLE", "unable to open control database", cause);
  } finally {
    clearTimeout(timer);
    remove?.();
  }
}
