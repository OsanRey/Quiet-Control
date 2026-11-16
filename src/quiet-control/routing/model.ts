import type {Rule,RuleSet,RuleTarget} from '../../types';
export type Condition={field:string;values:string[]}|{op:'all'|'any'|'not';children:Condition[]};
export type RoutingRule=Rule & {routing?:{name?:string;condition?:Condition;pool_id?:string;[key:string]:unknown}|null};
export type RoutingSet=Omit<RuleSet,'rules'> & {rules:RoutingRule[];node_ids?:string[]};
export interface RoutingDocument{version:number;core:string;mode:'rule'|'global'|'direct';fallback:string;selected_apps_only?:boolean;bypass_lan:boolean;find_process:boolean;rule_sets:RoutingSet[];legacy_rules:Rule[]}
export interface RoutingDraft{base_revision:string;document:RoutingDocument}
export interface Workspace{active:RoutingDocument;draft:RoutingDraft|null;revision:string;custom:boolean;capture:string;retired_presets?:number;previous?:RoutingDocument}
export interface RoutingIssue{severity:'error'|'warning';code:string;set_id:string|null;rule_id:string|null}
export interface Template{id:string;name:string;document:RoutingDocument}
export const uid=()=>crypto.randomUUID();
export const condition=(r:RoutingRule):Condition=>r.routing?.condition??{field:r.type==='process'?'process_name':r.type,values:[r.payload]};
export function summary(c:Condition):string{return 'field'in c?c.values.join(', '):c.children.map(summary).join(c.op==='any'?' ∨ ':c.op==='not'?' ¬ ':' ∧ ')}
export function freshSet(name:string):RoutingSet{return{id:uid(),name,builtin:false,enabled:true,ownership:'user',strategy:'smart',dns_strategy:'remote',dns_rules:[],rules:[]}}
export const actions:RuleTarget[]=['proxy','direct','block','node','smart','chain'];
