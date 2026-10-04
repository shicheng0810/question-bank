import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes } from '../app-data/canonical.js';
import { publicRegistryJson } from '../../../do-worker/src/account-public-registry.generated.js';
import { historicalPublicRegistry } from '../../../do-worker/src/historical-public-dependencies.generated.js';
import { secondHistoricalPublicRegistry } from '../../../do-worker/src/historical-public-second.generated.js';
import { reviewedReportPublicRegistry, reviewedReportPublicRegistrySnapshots } from '../../../do-worker/src/reviewed-report-public-registry.generated.js';

// Reviewed immutable receiver projections. A future producer must retain these
// entries and explicitly add a reviewed projection; arbitrary runtime hashes
// are never a source of trust.
const prior = JSON.parse(publicRegistryJson);
const pins = [
  ['prior8', '5762cc637b3ffabb034e5950ec994c72f17b2732ae90fd5b5370089a7ef22176', prior],
  ['new9', 'ea2bb666a4aad50eb54f0b5829e7d15c1306eab88be9e3ce29d00457f7f82aa4', [...prior, ...historicalPublicRegistry]],
  ['final10', '333327636c7a559bbaaa186cfa2a6f86d81e68bab547d73a9496bb68f1777469', [...prior, ...historicalPublicRegistry, secondHistoricalPublicRegistry]],
];
const projection = banks => banks.map(bank => ({ key: `${bank.bankUid}:${bank.revision}`, record: { bankUid: bank.bankUid, revision: bank.revision, metadata: bank.metadata, contentManifest: bank.contentManifest }, reference: bank.publicContentReference })).sort((a, b) => a.key.localeCompare(b.key));
const hash = value => Array.from(sha256(canonicalBytes(value)), b => b.toString(16).padStart(2, '0')).join('');
const baselineSnapshots = pins.map(([version, digest, banks], index) => {
  const actual = hash(projection(banks));
  if (banks.length !== 8 + index || actual !== digest) throw new Error('FROZEN_PUBLIC_REGISTRY_PIN_MISMATCH');
  return Object.freeze({ version, digest, banks });
});
const approvedBanks = [...baselineSnapshots[2].banks, ...reviewedReportPublicRegistry];
const byKey = new Map();
for (const bank of approvedBanks) {
  const key = `${bank.bankUid}:${bank.revision}`;
  if (byKey.has(key) && hash(byKey.get(key)) !== hash(bank)) throw new Error('FROZEN_PUBLIC_REGISTRY_CONFLICT');
  byKey.set(key, bank);
}
const versions = new Set(pins.map(row => row[0])), digests = new Set(pins.map(row => row[1]));
const extensions = reviewedReportPublicRegistrySnapshots.map(snapshot => {
  const {version,digest,banks} = snapshot;
  if (Object.keys(snapshot).sort().join() !== 'banks,digest,version' || typeof version !== 'string' || !version || versions.has(version) || digests.has(digest) || !Array.isArray(banks) || banks.length < 11 || hash(projection(banks)) !== digest) throw new Error('FROZEN_REPORT_PROJECTION_INVALID');
  const keys = new Set();
  for (const bank of banks) { const key=`${bank.bankUid}:${bank.revision}`;if(keys.has(key)||!byKey.has(key)||hash(bank)!==hash(byKey.get(key)))throw new Error('FROZEN_REPORT_MEMBER_INVALID');keys.add(key); }
  for (const bank of baselineSnapshots[2].banks) if(!keys.has(`${bank.bankUid}:${bank.revision}`))throw new Error('FROZEN_REPORT_BASE_MISSING');
  versions.add(version);digests.add(digest);return Object.freeze({version,digest,banks});
});
export const frozenPublicRegistrySnapshots = Object.freeze([...baselineSnapshots,...extensions]);
export const frozenPublicBanks = Object.freeze([...byKey.values()]);
