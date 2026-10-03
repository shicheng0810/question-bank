import{sha256}from'@noble/hashes/sha2.js';
const MAX=8*1024*1024,PIXELS=16777216;
const PNG_ALIAS_KEY='35a68cb2-b871-4d37-9447-190c396eaf99/e9b05621-6f45-4f12-ae99-edd728545229',PNG_ALIAS_REVISION='7dddd407905ddabfe91f02f7ad88c3d677c7453380b35bf8e2af11e05cf43f92',PNG_ALIAS_SOURCE_SHA='7f08055976e55a5a38d9517e28b1e895d1304054b0dca2f0601e2835cfd7ed22';
function displaySource(key,source,revision){
 if(key!==PNG_ALIAS_KEY||revision!==PNG_ALIAS_REVISION||typeof source!=='string'||source.length>Math.ceil(MAX/3)*4+32||!source.startsWith('data:image/jpeg;base64,'))return source;
 const digest=Array.from(sha256(new TextEncoder().encode(source)),b=>b.toString(16).padStart(2,'0')).join('');
 return digest===PNG_ALIAS_SOURCE_SHA?'data:image/png;base64,'+source.slice('data:image/jpeg;base64,'.length):source;
}
const fail=code=>{throw Object.assign(new Error(code),{code});};
const dimensions=(w,h)=>{if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>4096||h>4096)fail('RASTER_DIMENSIONS');};
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
export function validatePublicRasterData(input){
 if(typeof input!=='string'||input.length>Math.ceil(MAX/3)*4+32)fail('RASTER_BUDGET');
 const m=/^data:image\/(gif|png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(input);if(!m||!m[2]||m[2].length%4!==0)fail('RASTER_FORMAT');
 const raw=atob(m[2]);if(!raw.length||raw.length>MAX||btoa(raw)!==m[2])fail('RASTER_BASE64');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),v=new DataView(bytes.buffer);let width,height,frames=0,pixels=0;
 const need=(p,n)=>{if(p<0||n<0||p+n>bytes.length)fail('RASTER_TRUNCATED');};
 if(m[1]==='gif'){
  need(0,13);const header=String.fromCharCode(...bytes.subarray(0,6));if(!['GIF87a','GIF89a'].includes(header))fail('RASTER_MAGIC');width=v.getUint16(6,true);height=v.getUint16(8,true);dimensions(width,height);let p=13;const packed=bytes[10];if(packed&128){const n=3*(1<<((packed&7)+1));need(p,n);p+=n;}
  const blocks=()=>{let count=0;while(true){need(p,1);const n=bytes[p++];if(!n)return count;need(p,n);p+=n;count+=n;}};let ended=false;
  while(p<bytes.length){const tag=bytes[p++];if(tag===59){ended=true;break;}if(tag===33){need(p,1);const type=bytes[p++];if(type===249){need(p,6);if(bytes[p]!==4||bytes[p+5]!==0)fail('GIF_EXTENSION');p+=6;}else if(type===254)blocks();else if(type===255||type===1){need(p,1);const n=bytes[p++];if(n!==(type===255?11:12))fail('GIF_EXTENSION');need(p,n);p+=n;blocks();}else fail('GIF_EXTENSION');}
   else if(tag===44){need(p,9);const x=v.getUint16(p,true),y=v.getUint16(p+2,true),w=v.getUint16(p+4,true),h=v.getUint16(p+6,true),flags=bytes[p+8];dimensions(w,h);if(x+w>width||y+h>height||flags&24)fail('GIF_FRAME');pixels+=w*h;if(++frames>120||pixels>PIXELS)fail('GIF_FRAME_BUDGET');p+=9;if(flags&128){const n=3*(1<<((flags&7)+1));need(p,n);p+=n;}need(p,1);if(bytes[p]<2||bytes[p]>8)fail('GIF_LZW');p++;if(!blocks())fail('GIF_EMPTY_FRAME');}
   else fail('GIF_STRUCTURE');
  }if(!ended||p!==bytes.length||frames<1)fail('GIF_TRAILER');
 }else if(m[1]==='jpeg'){
  // T.81 marker/frame/scan metadata only; native image decoding is still the
  // pixel gate. No entropy decoding, EXIF execution or HTML data URL permission.
  need(0,2);if(bytes[0]!==255||bytes[1]!==216)fail('RASTER_MAGIC');
  let p=2,frameType,components,ended=false,scans=0,restartInterval=0;
  const quant=new Set(),huffman=new Set();
  while(p<bytes.length){
   need(p,2);if(bytes[p++]!==255)fail('JPEG_MARKER');while(bytes[p]===255){p++;need(p,1);}const marker=bytes[p++];
   if(marker===217){if(!components||scans<1||p!==bytes.length)fail('JPEG_TRAILER');ended=true;break;}
   if(marker===0||marker===216||marker===1||marker>=208&&marker<=215)fail('JPEG_MARKER');
   need(p,2);const n=v.getUint16(p);if(n<2)fail('JPEG_SEGMENT');need(p,n);const end=p+n;
   if(marker===192||marker===194){
    if(components||scans)fail('JPEG_FRAME');need(p,8);const count=bytes[p+7];
    if(bytes[p+2]!==8||![1,3].includes(count)||n!==8+3*count)fail('JPEG_FRAME');
    height=v.getUint16(p+3);width=v.getUint16(p+5);dimensions(width,height);pixels=width*height;if(pixels>PIXELS)fail('RASTER_PIXEL_BUDGET');
    components=new Map();let samples=0;for(let i=0;i<count;i++){const q=p+8+3*i,id=bytes[q],h=bytes[q+1]>>4,s=bytes[q+1]&15,t=bytes[q+2];if(components.has(id)||h<1||h>4||s<1||s>4||t>3)fail('JPEG_FRAME');components.set(id,t);samples+=h*s;}if(samples>10)fail('JPEG_FRAME');frameType=marker;
   }else if(marker===219){
    let q=p+2;while(q<end){const spec=bytes[q++];if(spec>>4!==0||(spec&15)>3||q+64>end)fail('JPEG_QUANTIZATION');for(let i=0;i<64;i++)if(bytes[q+i]===0)fail('JPEG_QUANTIZATION');quant.add(spec&15);q+=64;}if(q!==end||n===2)fail('JPEG_QUANTIZATION');
   }else if(marker===196){
    let q=p+2;while(q<end){if(q+17>end)fail('JPEG_HUFFMAN');const spec=bytes[q++],kind=spec>>4,id=spec&15;if(kind>1||id>3)fail('JPEG_HUFFMAN');let count=0,slots=1;for(let i=0;i<16;i++){const c=bytes[q++];count+=c;slots=slots*2-c;if(slots<0)fail('JPEG_HUFFMAN');}if(count<1||count>256||q+count>end)fail('JPEG_HUFFMAN');huffman.add(kind+':'+id);q+=count;}if(q!==end||n===2)fail('JPEG_HUFFMAN');
   }else if(marker===221){if(n!==4)fail('JPEG_RESTART');restartInterval=v.getUint16(p+2);
   }else if(marker===218){
    if(!components||++scans>128)fail('JPEG_SCAN');const count=bytes[p+2];if(count<1||count>components.size||n!==6+2*count)fail('JPEG_SCAN');const selected=new Set();let previous=-1;
    const ss=bytes[end-3],se=bytes[end-2],ah=bytes[end-1]>>4,al=bytes[end-1]&15;
    if(frameType===192&&(ss!==0||se!==63||ah!==0||al!==0))fail('JPEG_SCAN');
    if(frameType===194&&(ss>se||se>63||ss===0&&se!==0||ss>0&&count!==1||ah>13||al>13||ah!==0&&ah!==al+1))fail('JPEG_SCAN');
    const ids=[...components.keys()];for(let i=0;i<count;i++){const q=p+3+2*i,id=bytes[q],table=bytes[q+1],dc=table>>4,ac=table&15,ordinal=ids.indexOf(id);if(ordinal<0||ordinal<=previous||selected.has(id)||dc>3||ac>3||!quant.has(components.get(id)))fail('JPEG_SCAN');previous=ordinal;selected.add(id);if((frameType===192||ss===0&&ah===0)&&!huffman.has('0:'+dc)|| (frameType===192||ss>0)&&!huffman.has('1:'+ac))fail('JPEG_HUFFMAN');}
    p=end;let data=0,nextRestart=0;
    while(p<bytes.length){if(bytes[p]!==255){p++;data++;continue;}const start=p++;need(p,1);while(bytes[p]===255){p++;need(p,1);}const tag=bytes[p];if(tag===0){if(p!==start+1)fail('JPEG_SCAN');p++;data++;continue;}if(tag>=208&&tag<=215){if(!restartInterval||tag!==208+nextRestart||!data)fail('JPEG_RESTART');nextRestart=(nextRestart+1)%8;p++;continue;}p=start;break;}
    if(!data)fail('JPEG_EMPTY_SCAN');continue;
   }else if(!(marker>=224&&marker<=239||marker===254))fail('JPEG_UNSUPPORTED');
   p=end;
  }
  if(!ended)fail('JPEG_TRAILER');frames=1;
 }else{
  need(0,8);if(bytes.subarray(0,8).some((b,i)=>b!==[137,80,78,71,13,10,26,10][i]))fail('RASTER_MAGIC');let p=8,ihdr=false,idat=false,idatEnded=false,iend=false,palette=false,colorType;
  while(p<bytes.length){need(p,12);const n=v.getUint32(p),type=String.fromCharCode(...bytes.subarray(p+4,p+8));if(!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)||n>MAX)fail('PNG_CHUNK');need(p,n+12);if(crc(bytes.subarray(p+4,p+8+n))!==v.getUint32(p+8+n))fail('PNG_CRC');if(['acTL','fcTL','fdAT'].includes(type))fail('APNG_UNSUPPORTED');
   if(!ihdr&&type!=='IHDR')fail('PNG_ORDER');if(type==='IHDR'){if(ihdr||n!==13)fail('PNG_IHDR');ihdr=true;width=v.getUint32(p+8);height=v.getUint32(p+12);dimensions(width,height);pixels=width*height;if(pixels>PIXELS)fail('RASTER_PIXEL_BUDGET');const depth=bytes[p+16],color=bytes[p+17],allowed={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};if(!allowed[color]?.includes(depth)||bytes[p+18]!==0||bytes[p+19]!==0||bytes[p+20]>1)fail('PNG_IHDR');}
   else if(type==='PLTE'){if(palette||idat||[0,4].includes(colorType)||!n||n%3||n>768)fail('PNG_PALETTE');palette=true;}
   else if(type==='IDAT'){if(idatEnded||!n||colorType===3&&!palette)fail('PNG_IDAT');idat=true;}
   else if(type==='IEND'){if(!idat||n!==0)fail('PNG_IEND');iend=true;p+=12;break;}
   else{if(idat)idatEnded=true;if(type[0]===type[0].toUpperCase())fail('PNG_UNKNOWN_CRITICAL');}
   if(type==='IHDR')colorType=bytes[p+17];p+=n+12;
  }if(!iend||p!==bytes.length)fail('PNG_TRAILER');frames=1;
 }
 return {bytes,mime:'image/'+m[1],width,height,frames,frameRectanglePixels:pixels};
}
// Caller is the display owner, never HTML source. No URL/cap is accepted as input.
export function createPublicRasterDisplay(window){
 const owned=new Map(),retiring=new Set();let closed=false,pendingCount=0,pendingBytes=0;
 const schedule=window.setTimeout?.bind(window)||setTimeout,cancel=window.clearTimeout?.bind(window)||clearTimeout;
 // Resource backpressure is visible, not decode success or a relaxed input budget.
 const PENDING_COUNT=256,PENDING_BYTES=64*1024*1024,RETIRE_MS=10000;
 const settled=row=>{if(row.settled)return;row.settled=true;pendingCount--;pendingBytes-=row.bytes;};
 const release=row=>{if(row.released)return;row.released=true;settled(row);if(row.timer!==undefined)cancel(row.timer);retiring.delete(row);row.image.onload=null;row.image.onerror=null;row.image.removeAttribute('src');window.URL.revokeObjectURL(row.url);};
 const retire=row=>{if(row.released||row.retired)return;row.retired=true;if(row.settled){release(row);return;}retiring.add(row);row.timer=schedule(()=>release(row),RETIRE_MS);};
 const revoke=key=>{const rows=owned.get(key)||[];owned.delete(key);for(const row of rows)retire(row);};
 return Object.freeze({show(key,source,revision,canonicalQuestionKey=key){
  if(closed)fail('CLOSED');const result=validatePublicRasterData(displaySource(canonicalQuestionKey,source,revision));
  if(pendingCount>=PENDING_COUNT||pendingBytes+result.bytes.length>PENDING_BYTES)fail('RASTER_RESOURCE_BUSY');
  const image=window.document.createElement('img'),url=window.URL.createObjectURL(new window.Blob([result.bytes],{type:result.mime})),row={url,image,bytes:result.bytes.length,settled:false,retired:false,released:false,timer:undefined};pendingCount++;pendingBytes+=row.bytes;image.alt='figure';
  const finish=valid=>{if(row.released)return;settled(row);if(row.retired){release(row);return;}if(!valid){release(row);const notice=window.document.createElement('span');notice.textContent='Image unavailable: RASTER_DECODE';image.replaceWith(notice);}};
  image.onerror=()=>finish(false);image.onload=()=>finish(image.naturalWidth===result.width&&image.naturalHeight===result.height);
  const rows=owned.get(key)||[];rows.push(row);owned.set(key,rows);image.src=url;return image;
 },revoke,clear(){for(const key of [...owned.keys()])revoke(key);},close(){if(closed)return;closed=true;for(const key of [...owned.keys()])revoke(key);}});
}
