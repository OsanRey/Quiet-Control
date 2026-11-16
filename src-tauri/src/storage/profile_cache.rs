use super::store::{AppStore, StoredNode};
use crate::{domain::ProxyNode, error::AppResult};
use std::collections::{HashMap, HashSet};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProbe {pub latency_ms:Option<u32>,pub tested_at:i64,pub method:String,pub error:Option<String>}

/// Full connection shape, independent of display names, order and measurements.
/// Kept in memory only; credentials/fingerprints are never logged.
pub(crate) fn connection_shape(node: &ProxyNode) -> String {
    let mut value=serde_json::to_value(node).expect("serializable node");
    for key in ["id","name","latency_ms","latency_at","source","raw"] {value.as_object_mut().unwrap().remove(key);}
    if let Some(raw)=&node.raw {
        value["raw"]=match serde_yaml::from_str::<serde_yaml::Value>(raw) {
            Ok(mut v)=>{if let Some(m)=v.as_mapping_mut(){m.remove(&serde_yaml::Value::String("name".into()));}serde_json::to_value(v).unwrap_or_else(|_|raw.clone().into())},
            Err(_)=>raw.clone().into(),
        };
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Subscription,SubscriptionSource,Protocol,ProtocolConfig};
    fn sub(id:&str)->Subscription {Subscription{id:id.into(),name:id.into(),source:SubscriptionSource::Url{url:"https://example.invalid/fixture".into()},last_update:1,node_count:2,enabled:true,format:None,skipped_count:0,via_proxy:false,auto_update:false,auto_update_interval_min:1440,traffic:None,user_agent:None,http:Default::default()}}
    fn node(name:&str,server:&str)->ProxyNode {ProxyNode{id:String::new(),name:name.into(),protocol:Protocol::Trojan,server:server.into(),port:443,tls:None,transport:None,udp:None,config:ProtocolConfig::Trojan{password:"fixture".into()},source:None,raw:None,latency_ms:None,latency_at:None}.with_scoped_id("p")}
    fn seeded()->(AppStore,ProxyNode,ProxyNode) {
        let a=node("A","a.invalid");let b=node("B","b.invalid");let mut s=AppStore::default();s.schema_version=11;
        s.upsert_subscription(sub("p"),vec![a.clone(),b.clone()]).unwrap();s.settings.current_node_id=Some(a.id.clone());s.settings.last_manual_node_id=Some(a.id.clone());
        s.favorite_nodes.insert(b.id.clone());s.nodes[0].node.latency_ms=Some(42);s.nodes[0].node.latency_at=Some(123);s.nodes[0].latency_method=Some("clash_api".into());
        (s,a,b)
    }
    #[test] fn renamed_reordered_refresh_preserves_choice_favorites_and_measurements() {
        let (mut s,mut a,mut b)=seeded();let chosen=a.id.clone();let fav=b.id.clone();
        a.name="renamed A".into();b.name="renamed B".into();a.id="incoming-renamed-id".into();
        for _ in 0..3 {s.upsert_subscription(sub("p"),vec![b.clone(),a.clone()]).unwrap();}
        assert_eq!(s.nodes.len(),2);assert_eq!(s.settings.current_node_id.as_deref(),Some(chosen.as_str()));assert!(s.favorite_nodes.contains(&fav));
        let current=s.find_node(&chosen).unwrap();assert_eq!(current.name,"renamed A");assert_eq!(current.latency_ms,Some(42));assert_eq!(current.latency_at,Some(123));
    }
    #[test] fn empty_refresh_is_rejected_without_mutating_saved_cache() {
        let (mut s,_,_)=seeded();let before=serde_json::to_value(&s).unwrap();
        assert!(s.upsert_subscription(sub("p"),vec![]).is_err());assert_eq!(serde_json::to_value(&s).unwrap(),before);
    }
    #[test] fn removed_choice_is_retained_and_never_silently_replaced() {
        let (mut s,a,b)=seeded();
        for _ in 0..3{s.upsert_subscription(sub("p"),vec![b.clone()]).unwrap();s.ensure_current_node_valid();}
        assert_eq!(s.nodes.len(),2);assert_eq!(s.settings.current_node_id.as_deref(),Some(a.id.as_str()));assert!(s.settings.retained_node_ids.contains(&a.id));
        s.upsert_subscription(sub("p"),vec![a.clone(),b]).unwrap();assert!(!s.settings.retained_node_ids.contains(&a.id));assert_eq!(s.nodes.len(),2);
    }
    #[test] fn selected_node_and_latest_manual_result_survive_store_reload() {
        let (mut s,a,_)=seeded();s.manual_probe_results.insert(a.id.clone(),SavedProbe{latency_ms:Some(7),tested_at:456,method:"tcp".into(),error:None});
        let dir=std::env::temp_dir().join(format!("qc43-cache-{}-{}",std::process::id(),crate::config::generate_api_secret()));let path=dir.join("store.json");
        s.save(&path).unwrap();let r=AppStore::load(&path,None).unwrap();
        assert_eq!(r.settings.current_node_id,s.settings.current_node_id);assert_eq!(r.settings.last_manual_node_id,s.settings.last_manual_node_id);
        assert_eq!(r.manual_probe_results[&a.id].latency_ms,Some(7));assert_eq!(r.manual_probe_results[&a.id].tested_at,456);assert_eq!(r.favorite_nodes,s.favorite_nodes);
        let _=std::fs::remove_dir_all(dir);
    }
    #[test] fn returning_to_manual_restores_manual_choice_and_unrelated_local_nodes_remain() {
        let (mut s,a,b)=seeded();let mut local=sub("local");local.source=SubscriptionSource::Text{content:"fixture".into()};local.enabled=false;
        let mut own=node("Manual","manual.invalid");own.id="manual-id".into();s.upsert_subscription(local,vec![own]).unwrap();
        s.settings.current_node_id=Some(b.id.clone());s.settings.auto_select=crate::domain::AutoSelectMode::Off;
        assert!(s.restore_manual_selection());assert_eq!(s.settings.current_node_id.as_deref(),Some(a.id.as_str()));
        s.upsert_subscription(sub("p"),vec![a,b]).unwrap();assert!(s.find_node("manual-id").is_some());
    }
}

impl AppStore {
    pub(crate) fn remember_probes(&mut self, results:&[crate::services::latency::LatencyResult]) {
        for r in results {
            if self.nodes.iter().any(|n|n.node.id==r.id) {
                self.manual_probe_results.insert(r.id.clone(),SavedProbe{latency_ms:r.latency_ms,tested_at:r.tested_at,method:r.method.clone(),error:r.error.clone()});
            }
        }
    }
    pub(crate) fn restore_manual_selection(&mut self) -> bool {
        let Some(id)=self.settings.last_manual_node_id.clone().or_else(||self.settings.current_node_id.clone()) else {return false};
        self.settings.last_manual_node_id=Some(id.clone());
        let owner=self.nodes.iter().find(|n|n.node.id==id).map(|n|n.subscription_id.clone());
        if let Some(owner)=owner {
            if self.subscriptions.iter().any(|s|s.id==owner&&!s.enabled) {let _=self.activate_subscription(&owner);}
        }
        let changed=self.settings.current_node_id.as_ref()!=Some(&id);
        self.settings.current_node_id=Some(id);changed
    }
    pub(crate) fn merge_profile_cache(&mut self, id:&str, incoming:Vec<ProxyNode>) -> AppResult<Vec<StoredNode>> {
        let old:Vec<_>=self.nodes.iter().filter(|n|n.subscription_id==id).cloned().collect();
        let old_ids:HashSet<_>=old.iter().map(|n|n.node.id.clone()).collect();
        let mut by_shape:HashMap<String,Vec<&StoredNode>>=HashMap::new();
        for n in &old {by_shape.entry(connection_shape(&n.node)).or_default().push(n);}
        let mut counts=HashMap::new();
        for n in &incoming {*counts.entry(connection_shape(n)).or_insert(0usize)+=1;}
        let mut seen=HashSet::new();let mut merged=Vec::new();
        for mut node in incoming {
            if !seen.insert((connection_shape(&node),node.name.clone())) {continue;}
            let shape=connection_shape(&node);
            let previous=by_shape.get(&shape).and_then(|matches|{
                if matches.len()==1 && counts[&shape]==1 {Some(matches[0])}
                else {matches.iter().copied().find(|n|n.node.id==node.id)}
            });
            let mut method=None;
            if let Some(previous)=previous {
                node.id=previous.node.id.clone();node.latency_ms=previous.node.latency_ms;
                node.latency_at=previous.node.latency_at;method=previous.latency_method.clone();
            } else {
                self.manual_probe_results.remove(&node.id);
            }
            merged.push(StoredNode{subscription_id:id.into(),node,latency_method:method});
        }
        self.settings.retained_node_ids.retain(|key|!old_ids.contains(key));
        for n in old {
            let keep=self.settings.current_node_id.as_deref()==Some(n.node.id.as_str())
                || self.settings.last_manual_node_id.as_deref()==Some(n.node.id.as_str())
                || self.favorite_nodes.contains(&n.node.id);
            if keep && !merged.iter().any(|new|new.node.id==n.node.id) {
                self.settings.retained_node_ids.insert(n.node.id.clone());merged.push(n);
            }
        }
        Ok(merged)
    }
}
