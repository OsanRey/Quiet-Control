import {q} from '../i18n';
export const isServiceEntry=(reason:string)=>reason==='subscription.unusable_endpoint';
const reasons=['subscription.unusable_endpoint','xray_balancer_requires_custom_config','xray_multiple_outbounds_require_custom_config','xray_finalmask_requires_custom_config','unsupported_xray_protocol','unsupported_xray_transport','unsupported_xray_vless_encryption','unsupported_xray_hysteria_version','hysteria2: missing password'] as const;
export function describeImportSkip(reason:string):string {
 const code=reasons.find(code=>code===reason);
 return code?q(code):reason;
}
