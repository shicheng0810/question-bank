import { publicCorrection } from '../functions/_shared/public-report-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,cp,mkdir,writeFile,symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { reportFixture } from './report-runtime/fixture.js';
import { correctionFiles } from '../scripts/banks/report-correction-files.mjs';
import { parseReportExtension } from '../scripts/banks/apply-native-report-request.mjs';
import { frozenPublicRegistrySnapshots } from '../src/domain/question/frozen-public-registry.js';
import { encodeContent } from '../src/domain/attempt/commands.js';
import { canonicalContentBytes,sha256Hex } from '../src/domain/app-data/canonical.js';

test('two successive Reports preserve first publication projection and cold receiver/asset restoration',async()=>{
  const fixture=await reportFixture(),baseline=frozenPublicRegistrySnapshots.find(snapshot=>snapshot.version==='final10').banks;
  const encoded=await encodeContent(fixture.content),initialEntry={bankUid:fixture.content.bankUid,revision:fixture.source.revision,metadata:fixture.content.metadata,contentManifest:{kind:'public_static',staticRef:`banks/v2/test.${fixture.source.revision}.json`,contentDigest:fixture.source.revision},publicContentReference:encoded.reference,questionsrefs:fixture.content.questions.map(q=>({questionKey:q.questionKey,questionRevision:q.questionRevision}))};
  const projection=banks=>banks.map(bank=>({key:`${bank.bankUid}:${bank.revision}`,record:{bankUid:bank.bankUid,revision:bank.revision,metadata:bank.metadata,contentManifest:bank.contentManifest},reference:bank.publicContentReference})).sort((a,b)=>a.key.localeCompare(b.key));
  // Synthetic bank registration is an explicitly reviewed seed; baseline10 is
  // the real immutable baseline and is never replaced by synthetic pin hashes.
  const seedBanks=[...baseline,initialEntry],extensions={entries:[initialEntry],snapshots:[{version:'reviewed-fixture-seed',digest:await sha256Hex(canonicalContentBytes(projection(seedBanks))),banks:seedBanks}]};
  const manifest={banks:[{slug:'test',bankUid:initialEntry.bankUid,revision:initialEntry.revision,contentFile:'test.registered.json',sha256:await sha256Hex(canonicalContentBytes(fixture.content)),staticRef:initialEntry.contentManifest.staticRef}]};
  const registry={questions:initialEntry.questionsrefs};
  const first=await correctionFiles(fixture.content,manifest,registry,fixture.body,fixture.source,seedBanks,extensions,baseline);
  const firstExtension=parseReportExtension(first.files[3].content),firstContent=JSON.parse(first.files[0].content),firstManifest=JSON.parse(first.files[1].content),firstRegistry=JSON.parse(first.files[2].content),firstSnapshot=structuredClone(firstExtension.snapshots.at(-1));
  const firstEntry=firstExtension.entries.at(-1),firstQuestion=firstContent.questions[0],firstSource={...fixture.source,revision:first.revision,sourcePath:first.files[0].path};
  const secondBody={...fixture.body,operationId:crypto.randomUUID(),revision:first.revision,questionRevision:firstQuestion.questionRevision,corrected:{question:'Second correction',choices:['A','B'],answer:0}};
  const second=await correctionFiles(firstContent,firstManifest,firstRegistry,secondBody,firstSource,[...baseline,...firstExtension.entries],firstExtension,baseline);
  const secondExtension=parseReportExtension(second.files[3].content);
  assert.deepEqual(secondExtension.snapshots.find(snapshot=>snapshot.version===firstSnapshot.version),firstSnapshot);
  assert.equal(secondExtension.snapshots.at(-1).banks.length,baseline.length+3);
  assert.equal(secondExtension.entries.find(entry=>entry.revision===first.revision).questionsrefs[0].questionRevision,firstQuestion.questionRevision);
  const historicalBytes=new TextEncoder().encode(first.files[0].content);assert.equal(await sha256Hex(historicalBytes),first.revision);
  // Cold-load the actual browser verifier and receiver in a separate module
  // tree with the second publication extension, without changing live source.
  const root=await mkdtemp(path.join(tmpdir(),'qb-report-cold-'));await cp('src',path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'do-worker'),{recursive:true});await cp('do-worker/src',path.join(root,'do-worker/src'),{recursive:true});await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');await writeFile(path.join(root,'package.json'),'{"type":"module"}');await writeFile(path.join(root,second.files[3].path),second.files[3].content);
  const cold=await import(pathToFileURL(path.join(root,'src/browser/cloud-recovery-v2.js')).href),receiver=await import(pathToFileURL(path.join(root,'do-worker/src/account-public-registry.js')).href);
  const row={sourceChange:{serverSeq:'1',accountGeneration:'11111111-1111-4111-8111-111111111111',kind:'bank_revision',entityKey:`bank:${firstEntry.bankUid}`,payloadDigest:'0'.repeat(64),serverRevision:1,payload:{schemaVersion:1,bankUid:firstEntry.bankUid,revision:firstEntry.revision,metadata:firstEntry.metadata,contentManifest:firstEntry.contentManifest,baseRevision:0}},reference:firstEntry.publicContentReference,provenance:{kind:'frozen_public_static',bankUid:firstEntry.bankUid,revision:firstEntry.revision,staticRef:firstEntry.contentManifest.staticRef,registryDigest:firstSnapshot.digest}};
  assert.equal((await cold.verifyFrozenCloudPublicReference(row)).revision,first.revision);
  assert.ok(receiver.loadAccountPublicRegistry({}).has(`${firstEntry.bankUid}:${first.revision}`));
  const recovered=JSON.parse(new TextDecoder().decode(historicalBytes));assert.equal(recovered.questions[0].answer,1);assert.equal(recovered.questions[0].questionRevision,firstQuestion.questionRevision);assert.notEqual(recovered.questions[0].questionRevision,JSON.parse(second.files[0].content).questions[0].questionRevision);
  const baselineModule=await import(pathToFileURL(path.join(root,'src/domain/question/frozen-public-registry.js')).href);assert.equal(baselineModule.frozenPublicRegistrySnapshots.find(snapshot=>snapshot.version==='final10').digest,frozenPublicRegistrySnapshots.find(snapshot=>snapshot.version==='final10').digest);
});
