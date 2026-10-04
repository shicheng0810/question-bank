import { reportError } from './native-report.js';
const fields=['operationId','bankUid','revision','questionUid','questionKey','questionRevision','corrected','question_index'];
// Private report notes, identities and provider/account metadata never cross the
// public repository boundary. Only an administrator-approved public correction.
export function publicCorrection(pending) {
  const result=Object.fromEntries(fields.map(key=>[key,structuredClone(pending[key]??null)]));
  const text=JSON.stringify(result.corrected);
  if(/ghp_|github_pat_|AIza|AKIA[0-9A-Z]|BEGIN[^\n]*PRIVATE KEY|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\/(?:Users|home)\//i.test(text))throw reportError('REPORT_PUBLIC_CORRECTION_SENSITIVE');
  return result;
}
export function assertPublicRequest(request) {
  if(Object.keys(request||{}).sort().join()!=='baseCommit,format,pending' || request.format!=='qb-native-report-request-v1' || !/^[a-f0-9]{40}$/.test(request.baseCommit) || Object.keys(request.pending||{}).sort().join()!==fields.slice().sort().join())throw reportError('REPORT_PUBLIC_REQUEST_FIELDS_INVALID');
  publicCorrection(request.pending);
  return request;
}
