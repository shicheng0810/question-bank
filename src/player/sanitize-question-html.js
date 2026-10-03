import createDOMPurify from 'dompurify';

export const QUESTION_HTML_PURIFIER_VERSION='3.4.16';
const HTML_NS='http://www.w3.org/1999/xhtml';
const FORMATTING=['p','br','span','div','strong','b','em','i','u','s','sub','sup','blockquote','pre','code','ul','ol','li','table','thead','tbody','tfoot','tr','td','th','caption','hr','figure','figcaption','img'];
const FORBIDDEN=['svg','math','script','style','form','label','button','textarea','select','option','iframe','object','embed','video','audio','source','track','link','meta','base','template'];
const CONTROL=/[\u0000-\u0020\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const fail=code=>Object.assign(new Error(code),{code});
function capture(input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).some(key=>typeof key!=='string')||Object.keys(input).sort().join()!=='blanksCount,html,mode')throw fail('QUESTION_HTML_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(input);for(const value of Object.values(descriptors))if(!value.enumerable||!Object.hasOwn(value,'value'))throw fail('QUESTION_HTML_INPUT');
  const {html,mode,blanksCount}=Object.fromEntries(Object.entries(descriptors).map(([key,value])=>[key,value.value]));
  if(typeof html!=='string'||!['question-inline','choice'].includes(mode)||!Number.isSafeInteger(blanksCount)||blanksCount<0||blanksCount>5000||html.length>3*1024*1024||new TextEncoder().encode(html).length>3*1024*1024)throw fail('QUESTION_HTML_INPUT');
  return {html,mode,blanksCount};
}
function safeLink(raw,origin){
  if(typeof raw!=='string'||!raw||CONTROL.test(raw)||raw.includes('\\'))return null;
  let decoded=raw;try{for(let i=0;i<3;i++){const next=decodeURIComponent(decoded);if(CONTROL.test(next)||next.includes('\\'))return null;if(next===decoded)break;decoded=next;}}catch{return null;}
  if(/^[a-z][a-z0-9+.-]*:/i.test(decoded)&&!/^https?:/i.test(decoded))return null;
  try{const url=new URL(raw,origin+'/');if(url.username||url.password||!(url.protocol==='https:'||url.origin===origin&&url.protocol==='http:'))return null;return url.href;}catch{return null;}
}
function safeRaster(raw,origin){
  if(typeof raw!=='string'||CONTROL.test(raw)||raw.includes('\\')||raw.includes('%')||raw.includes('?')||raw.includes('#'))return null;
  try{const url=new URL(raw,origin+'/');if(url.origin!==origin||url.username||url.password||!/^\/(assets|banks)\/[a-z0-9_./-]+\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname))return null;return url.href;}catch{return null;}
}

/** Display-only browser policy. Returns a detached DOM fragment, not a string
 * to concatenate into another parsing context. Stored source/revision/digest
 * and grading identity are never modified. No server/jsdom fallback is used.
 * Each call has its own purifier/hooks, preventing mutable cross-call policy.
 */
export function createQuestionHtmlSanitizer(browserWindow){
  const window=browserWindow;
  if(!window?.document?.createDocumentFragment||!window.Element?.prototype||!window.Node?.prototype)throw fail('BROWSER_DOM_REQUIRED');
  const origin=window.location.origin;if(!/^https?:\/\//.test(origin))throw fail('TRUSTED_HTML_ORIGIN_REQUIRED');
  const attr=(node,key)=>window.Element.prototype.getAttribute.call(node,key);
  const remove=node=>{if(node.parentNode)window.Node.prototype.removeChild.call(node.parentNode,node);};
  return Object.freeze({sanitize(input){
    const {html,mode,blanksCount}=capture(input),purifier=createDOMPurify(window);
    if(purifier.version!==QUESTION_HTML_PURIFIER_VERSION||purifier.isSupported!==true){const fragment=window.document.createDocumentFragment();fragment.appendChild(window.document.createTextNode(html));return Object.freeze({fragment,mode:'plaintext',degraded:true});}
    const seen=new Set(),inline=mode==='question-inline';
    purifier.addHook('uponSanitizeElement',(node,data)=>{
      if(node.nodeType!==1)return;
      if(node.namespaceURI!==HTML_NS){remove(node);return;}
      if(data.tagName!=='input')return;
      const index=attr(node,'data-blank');let ancestor=node.parentNode,nested=false;
      while(ancestor&&ancestor.nodeType===1){if(['a','button','input','label','form'].includes(ancestor.localName)){nested=true;break;}ancestor=ancestor.parentNode;}
      const type=attr(node,'type'),className=attr(node,'class');
      if(!inline||nested||type!==null&&type!=='text'||className!==null&&className!=='qb-blank'||!index||!/^[1-9][0-9]{0,3}$/.test(index)||Number(index)>blanksCount||seen.has(index)){remove(node);return;}seen.add(index);
      window.Element.prototype.setAttribute.call(node,'type','text');window.Element.prototype.setAttribute.call(node,'class','qb-blank');
    });
    purifier.addHook('uponSanitizeAttribute',(node,data)=>{
      const name=data.attrName,tag=node.localName;
      data.keepAttr=false;
      if(name==='title'||name==='alt'&&tag==='img'){data.keepAttr=true;return;}
      if(['colspan','rowspan'].includes(name)&&['td','th'].includes(tag)&&/^[1-9][0-9]{0,2}$/.test(data.attrValue)&&Number(data.attrValue)<=100){data.keepAttr=true;return;}
      if(tag==='a'&&inline&&name==='href'){const value=safeLink(data.attrValue,origin);if(value){data.attrValue=value;data.keepAttr=true;}return;}
      if(tag==='img'&&name==='src'){const value=safeRaster(data.attrValue,origin);if(value){data.attrValue=value;data.keepAttr=true;}return;}
      if(tag==='input'&&inline&&['type','class','data-blank'].includes(name)){data.keepAttr=true;}
    });
    purifier.addHook('afterSanitizeAttributes',node=>{
      if(node.nodeType!==1)return;
      if(node.localName==='a'&&attr(node,'href')){window.Element.prototype.setAttribute.call(node,'rel','noopener noreferrer');window.Element.prototype.setAttribute.call(node,'target','_blank');}
      if(node.localName==='img'&&!attr(node,'src'))remove(node);
    });
    const fragment=purifier.sanitize(html,{ALLOWED_TAGS:[...FORMATTING,...(inline?['a','input']:[])],ALLOWED_ATTR:['title','alt','colspan','rowspan','href','src','type','class','data-blank'],FORBID_TAGS:FORBIDDEN,FORBID_CONTENTS:FORBIDDEN,FORBID_ATTR:['style','id','name','value','autofocus','srcset','ping','download','form','formaction'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,ALLOW_UNKNOWN_PROTOCOLS:false,CUSTOM_ELEMENT_HANDLING:{tagNameCheck:null,attributeNameCheck:null,allowCustomizedBuiltInElements:false},SANITIZE_DOM:true,SANITIZE_NAMED_PROPS:true,RETURN_DOM_FRAGMENT:true,RETURN_TRUSTED_TYPE:false});
    return Object.freeze({fragment,mode,degraded:false});
  }});
}
