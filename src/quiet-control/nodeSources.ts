import type {ProxyNode,SubscriptionView} from '../types';
export function matchesNodeSource(node:ProxyNode,source:string,profiles:SubscriptionView[]):boolean {
 if(source==='all')return true;
 if(source==='local')return profiles.some(p=>p.id===node.subscription_id&&p.source_kind!=='url'&&p.source_kind!=='custom');
 return node.subscription_id===source;
}
export function probeGroups(ids:string[],nodes:ProxyNode[]):Map<string,string[]> {
 const byId=new Map(nodes.map(n=>[n.id,n]));const groups=new Map<string,string[]>();
 for(const id of ids){const owner=byId.get(id)?.subscription_id;if(!owner)continue;const list=groups.get(owner)??[];list.push(id);groups.set(owner,list);}
 return groups;
}
