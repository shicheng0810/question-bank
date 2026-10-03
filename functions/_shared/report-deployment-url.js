export function reportDeploymentURL(deployment,resultCommit){
 let url;try{url=new URL(deployment?.url);}catch{throw Error('REPORT_READBACK_TARGET');}
 if(!/^[a-f0-9]{8}$/.test(deployment.shortId||'')||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||url.hostname!==deployment.shortId+'.question-bank-78u.pages.dev'||!/^[-a-f0-9]{36}$/.test(deployment.deploymentId||'')||(resultCommit&&deployment.resultCommit!==resultCommit))throw Error('REPORT_READBACK_TARGET');
 return url.href;
}
