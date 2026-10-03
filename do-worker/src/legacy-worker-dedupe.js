import {parseFragment} from 'parse5';
import {dedupeLegacyQuestionBank} from '../../src/domain/question/legacy-runtime-identity.js';
// Chromium template.innerHTML is an inert fragment (including noscript parsing).
// textContent excludes nested template.content, and removed script/style nodes.
export function legacyTemplateText(value){
 const text=String(value??'');if(!text.includes('<'))return text;
 const visit=node=>node.nodeName==='script'||node.nodeName==='style'?'':node.nodeName==='#text'?node.value:(node.childNodes||[]).map(visit).join('');
 return visit(parseFragment(text,{scriptingEnabled:false}));
}
export function dedupeWorkerLegacyQuestionBank(questions){
 return dedupeLegacyQuestionBank(questions.map(q=>({...q,question:legacyTemplateText(q.question),
  ...(Array.isArray(q.choices)?{choices:q.choices.map(legacyTemplateText)}:{}),
  ...(Array.isArray(q.blanks)?{blanks:q.blanks.map(row=>Array.isArray(row)?row.map(legacyTemplateText):legacyTemplateText(row))}:{})})));
}
