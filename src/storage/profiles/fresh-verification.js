import { APP_DATA_STORES, canonicalDigest } from "../../domain/app-data/index.js";
import { openProfileContext } from "../idb/profile-context.js";
import { profileError } from "./control-schema.js";
import { BUSINESS_SCHEMA_VERSION } from '../idb/schema.js';

const STORE_NAMES = Object.freeze(Object.keys(APP_DATA_STORES).sort());

/** @param {{profile:unknown,blockedTimeoutMs:number,signal?:AbortSignal}} options */
export async function inspectFreshBusinessProfile(options) {
  const context = await openProfileContext({ profile: options.profile, openMode: "existing", blockedTimeoutMs: options.blockedTimeoutMs, signal: options.signal });
  try {
    /** @type {Promise<number>[]} */
    const requests = [];
    await context.transaction(STORE_NAMES, "readonly", (tx) => {
      for (const name of STORE_NAMES) {
        const request = tx.objectStore(name).count();
        request.catch(() => {});
        requests.push(request);
      }
    });
    const counts = await Promise.all(requests);
    if (counts.some((count) => count !== 0)) throw profileError("FRESH_VERIFICATION_FAILED", "fresh profile contains business records");
    const manifest = Object.freeze({
      format: "qb-b1a-fresh-manifest-v1",
      businessSchemaVersion: BUSINESS_SCHEMA_VERSION,
      stores: STORE_NAMES.map((name) => Object.freeze({ name, recordCount: 0 }))
    });
    return Object.freeze({ manifest, contentDigest: await canonicalDigest(manifest) });
  } catch (cause) {
    if (cause?.code) throw cause;
    throw profileError("FRESH_VERIFICATION_FAILED", "fresh business inspection failed", cause);
  } finally {
    context.close();
  }
}
