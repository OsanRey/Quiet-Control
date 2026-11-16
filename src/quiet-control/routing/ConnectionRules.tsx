import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {routingWorkspace} from '../../api';
import type {ConnectionView} from '../../types';
import type {RoutingDocument,RoutingSet} from './model';
import {ruleSetName} from '../ruleNames';
import {useRoutingText} from './messages';
const Context=createContext<RoutingDocument|undefined>(undefined);
export function ConnectionRulesProvider({children}:{children:ReactNode}){
 const [doc,setDoc]=useState<RoutingDocument>();
 useEffect(()=>{let alive=true;void routingWorkspace().then(w=>{if(alive)setDoc(w.active)}).catch(()=>{});return()=>{alive=false}},[]);
 return <Context.Provider value={doc}>{children}</Context.Provider>;
}
export function observedGroup(doc:RoutingDocument|undefined,r:ConnectionView):RoutingSet|undefined {
 if(!doc)return;const ids=[...r.rule.matchAll(/rule_set=([^ =>,]+)/g)].map(m=>m[1]);if(r.rule_payload)ids.push(r.rule_payload);
 return doc.rule_sets.find(s=>ids.some(id=>id===s.id||id.startsWith(s.id+'-route-')));
}
export function useConnectionRuleName(r:ConnectionView){
 const doc=useContext(Context);const t=useRoutingText();const group=observedGroup(doc,r);
 if(group)return ruleSetName(group);
 if(r.rule==='final'||r.rule==='Match')return t('fallback');
 if(r.rule.startsWith('ProcessName('))return r.process?t('appType')+': '+r.process:t('engineRule');
 return r.rule?t('engineRule'):t('noMatchedRule');
}
