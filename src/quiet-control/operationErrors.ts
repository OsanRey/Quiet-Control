import {q} from '../i18n';
export function subscriptionErrorSummary(message:string):string|null {
 const marker='subscription.check_failed ';
 const start=message.indexOf(marker);if(start<0)return null;
 try {
  const report=JSON.parse(message.slice(start+marker.length));
  if(!Array.isArray(report.attempts))return null;
  const last=report.attempts[report.attempts.length-1];
  if(last?.result==='device_required')return q(last.device?.id_sent?'subscription.error.device_rejected':'subscription.error.device_required');
  if(last?.result==='device_limit')return q('subscription.error.device_limit');
  if(last?.result==='placeholder')return q('subscription.error.placeholder');
  if(last?.result==='suspicious_endpoint')return q('subscription.error.suspicious');
  return q('subscription.error.rejected');
 }catch{return null;}
}
const codes=['sources.stop_before_delete','subscription.partial_xray_refresh_kept_cache','routing.apps.xray_unavailable','routing.presets.retired','routing.apps.requires_rule_mode','probe.singbox_https_only','probe.no_tcp','probe.stateful_protocol','probe.xray_no_delay_api','probe.core_unsupported','subscription.empty_refresh_kept_cache','selection.choose_node_before_connect','selection.unsupported_node','selection.profile_changed','selection.api_unavailable','selection.custom_read_only','selection.not_ready','selection.restore_failed'] as const;
export function explainOperationError(message:string):string {
 const code=codes.find(code=>message.includes(code));
 return code?q(code):message;
}
