import { finalizeRegisteredQuestions } from '../../src/domain/question/registered-identity.js';
import { validateBankContent } from '../../src/domain/question/bank-content.js';
export async function reportFixture(operationId=crypto.randomUUID()) {
  const bankUid='11111111-1111-4111-8111-111111111111',questionUid='22222222-2222-4222-8222-222222222222';
  const questions=await finalizeRegisteredQuestions([{bankUid,questionUid,questionKey:`${bankUid}/${questionUid}`,question:'Public test',choices:['A','B'],answer:0,provenance:[]}]);
  const content={format:'qb-bank-content-v2',schemaVersion:1,bankUid,metadata:{title:'Test',visibility:'public',questionCount:1},questions};
  const {contentDigest:revision}=await validateBankContent(content);
  return {content,source:{bankUid,revision,visibility:'public',sourcePath:'content/test.registered.json',manifestPath:'content/manifest.json',registryPath:'content/registry.json'},body:{kind:'question_edit',schema_version:2,operationId,bankUid,revision,questionUid,questionKey:questions[0].questionKey,questionRevision:questions[0].questionRevision,corrected:{question:'Public correction',choices:['A','B'],answer:1},note:''}};
}
