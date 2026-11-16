import {q, type MessageKey} from '../i18n';
import type {RuleSetSummary} from '../types';
const factoryNames: Record<string,[string,MessageKey]> = {
 'system-geolocation-not-cn':['海外网站','stage3.rulesOverseas'],
 'system-geoip-cn':['国内ip','stage3.rulesChinaIp'],
 'system-geosite-cn':['国内站点','stage3.rulesChinaSites'],
 'dns-builtin-dns-direct':['内置 DNS 规则 · 直连','stage4.dnsDirect'],
 'dns-builtin-dns-proxy':['内置 DNS 规则 · 代理','stage4.dnsProxy'],
 'dns-builtin-dns-smart':['内置 DNS 规则 · 智能','stage4.dnsSmart'],
 'dns-builtin-dns-block':['内置 DNS 规则 · 智能','stage4.dnsBlock'],
};
/** Only untouched factory names are localized. Renames and user sets are data. */
export function ruleSetName(set: Pick<RuleSetSummary,'id'|'name'>): string {
 const spec=factoryNames[set.id];return spec&&set.name===spec[0]?q(spec[1]):set.name;
}
export function diagnosticAliases(sets: Pick<RuleSetSummary,'id'|'name'>[]): Map<string,string> {
 return new Map(sets.filter(set=>ruleSetName(set)!==set.name&&sets.filter(s=>s.name===set.name).length===1).map(set=>[set.name,ruleSetName(set)]));
}
