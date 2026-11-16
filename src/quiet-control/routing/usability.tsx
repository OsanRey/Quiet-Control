import type {RoutingDocument,RoutingRule,RoutingSet} from './model';
import {condition} from './model';
import {useRoutingText} from './messages';
export type AppException={id:string;enabled:boolean;scope:'domain'|'domain_suffix';domains:string[];target:'direct'|'proxy'|'block'};
export const exceptions=(r:RoutingRule):AppException[]=>Array.isArray(r.routing?.app_exceptions)?r.routing.app_exceptions as AppException[]:[];
export const simpleApp=(r:RoutingRule)=>{const c=condition(r);return 'field'in c&&['process_name','process_path'].includes(c.field)};
export const supportsExceptions=(s:RoutingSet|undefined)=>!!s&&!s.remote&&['smart','proxy','direct','block'].includes(s.strategy);
export const nameOf=(r:RoutingRule)=>r.routing?.name||('field'in condition(r)?r.payload:'');
export function changes(before:RoutingDocument,after:RoutingDocument){
 const rows:{kind:'added'|'removed'|'edited'|'moved';name:string}[]=[];
 for(const s of after.rule_sets){const old=before.rule_sets.find(x=>x.id===s.id);if(!old){rows.push({kind:'added',name:s.name});continue}
  if(before.rule_sets.indexOf(old)!==after.rule_sets.indexOf(s))rows.push({kind:'moved',name:s.name});
  if(JSON.stringify({...old,rules:[]})!==JSON.stringify({...s,rules:[]}))rows.push({kind:'edited',name:s.name});
  for(const r of s.rules){const prev=old.rules.find(x=>x.id===r.id);if(!prev)rows.push({kind:'added',name:nameOf(r)});else if(JSON.stringify(r)!==JSON.stringify(prev))rows.push({kind:'edited',name:nameOf(r)});}
  for(const r of old.rules)if(!s.rules.some(x=>x.id===r.id))rows.push({kind:'removed',name:nameOf(r)});
 }
 for(const s of before.rule_sets)if(!after.rule_sets.some(x=>x.id===s.id))rows.push({kind:'removed',name:s.name});
 if(JSON.stringify({...before,rule_sets:[]})!==JSON.stringify({...after,rule_sets:[]}))rows.push({kind:'edited',name:'settings'});
 return rows;
}
/** Conservative warning, never a claim that a runtime connection was observed. */
export function shadowed(d:RoutingDocument){
 const earlier:RoutingRule[]=[];const out:{rule:RoutingRule;earlier:RoutingRule}[]=[];
 for(const s of d.rule_sets.filter(s=>s.enabled&&!s.remote))for(const r of [...s.rules].sort((a,b)=>a.ord-b.ord).filter(r=>r.enabled)){
  const expr=condition(r);if('field'in expr){const hit=earlier.find(e=>{const c=condition(e);return 'field'in c&&c.field===expr.field&&expr.values.every(v=>c.values.some(x=>x.toLowerCase()===v.toLowerCase()))});if(hit)out.push({rule:r,earlier:hit});}earlier.push(r);
 }return out;
}
export function ExceptionBranch({rule,onEdit}:{rule:RoutingRule;onEdit:()=>void}){
 const t=useRoutingText();const list=exceptions(rule);if(!list.length)return null;
 return <div className="routing-exception-branch"><button onClick={onEdit}>{t('appExceptions')} · {list.length}</button>{list.map(e=><div className={!rule.enabled||!e.enabled?'is-disabled':''} key={e.id}><span>↳ {e.domains.join(', ')||t('emptyDomain')}</span><small>{t(e.scope)} · {t(e.target)}</small></div>)}</div>;
}
export function ChangeSummary({before,after}:{before:RoutingDocument;after:RoutingDocument}){
 const t=useRoutingText();const rows=changes(before,after);
 return <section className="routing-change-summary"><strong>{t('changeSummary')} · {rows.length}</strong><ul>{rows.slice(0,40).map((r,i)=><li key={i}>{t(r.kind)}: {r.name==='settings'?t('routingSettings'):r.name||t('rule')}</li>)}</ul>{rows.length>40&&<p>{t('moreChanges')} {rows.length-40}</p>}</section>;
}
