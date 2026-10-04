export { nativeReportWebhook as onRequestPost } from '../_shared/native-report-webhook.js';
export function onRequestGet(){return new Response('tg-webhook up',{headers:{'content-type':'text/plain; charset=utf-8'}});}
