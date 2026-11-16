//! Explicit process allowlist, shared by all generators and static prediction.
use crate::{config::BuildOptions, domain::{Rule, RuleSet, OutboundMode}};
use serde_json::Value;
use std::borrow::Cow;

/// True only when every matching branch requires a positive process identity.
/// In particular OR(process, domain), NOT(process), and unknown processes must
/// never provide a path to VPN in selected-apps mode.
pub fn process_bound(v: &Value) -> bool {
    match v.get("op").and_then(Value::as_str) {
        Some("all") => v["children"].as_array().is_some_and(|c| c.iter().any(process_bound)),
        Some("any") => v["children"].as_array().is_some_and(|c| !c.is_empty() && c.iter().all(process_bound)),
        Some(_) => false,
        None => matches!(v["field"].as_str(), Some("process_name"|"process_path"))
            && v["values"].as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|v|v.as_str().is_some_and(|s| !s.trim().is_empty()))),
    }
}
pub fn app_rules(rules: &[Rule]) -> Vec<Rule> {
    rules.iter().filter(|r| process_bound(&super::conditions::expression(r))).cloned().collect()
}
pub fn app_sets(sets: &[RuleSet]) -> Vec<RuleSet> {
    sets.iter().filter(|s| !s.builtin && s.remote.is_none()).filter_map(|s| {
        let mut set=s.clone();set.rules=app_rules(&s.rules);
        (!set.rules.is_empty()).then_some(set)
    }).collect()
}
pub fn options(opts: &BuildOptions) -> Cow<'_, BuildOptions> {
    if !opts.selected_apps_only && !super::exceptions::present(&opts.rule_sets,&opts.rules){return Cow::Borrowed(opts)}
    let mut next=opts.clone();
    if opts.selected_apps_only {
        next.rule_sets=app_sets(&opts.rule_sets);
        next.rules=if opts.rule_sets.is_empty(){app_rules(&opts.rules)}else{Vec::new()};
        next.outbound_mode=OutboundMode::Rule;next.route_final="direct".into();next.find_process=true;
    }
    next.rule_sets=super::exceptions::sets(&next.rule_sets);
    if next.rule_sets.is_empty(){next.rules=super::exceptions::rules(&next.rules,None)}
    Cow::Owned(next)
}
pub fn document(d:&super::Document)->Cow<'_,super::Document>{
    if !d.selected_apps_only && !super::exceptions::present(&d.rule_sets,&d.legacy_rules){return Cow::Borrowed(d)}
    let mut next=d.clone();
    if d.selected_apps_only {
        next.rule_sets=app_sets(&d.rule_sets);next.legacy_rules=app_rules(&d.legacy_rules);
        next.mode=OutboundMode::Rule;next.fallback="direct".into();next.find_process=true;
    }
    next.rule_sets=super::exceptions::sets(&next.rule_sets);
    next.legacy_rules=super::exceptions::rules(&next.legacy_rules,None);Cow::Owned(next)
}
pub fn retired_china_set(set:&RuleSet)->bool {
    set.builtin && crate::domain::is_builtin_remote_id(&set.id)
}
pub fn without_china(d:&super::Document)->super::Document {
    let mut next=d.clone();next.rule_sets.retain(|s|!retired_china_set(s));next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{domain::{RuleType,RuleTarget,RuleSetStrategy}, storage::AppStore};
    use serde_json::json;
    #[test] fn every_matching_branch_must_require_a_process() {
        let p=json!({"field":"process_name","values":["msedge.exe"]});
        let d=json!({"field":"domain","values":["riotgames.com"]});
        assert!(process_bound(&p));
        assert!(!process_bound(&json!({"op":"any","children":[p.clone(),d.clone()]})));
        assert!(process_bound(&json!({"op":"all","children":[p.clone(),d]})));
        assert!(!process_bound(&json!({"op":"not","children":[p.clone()]})));
        assert!(!process_bound(&json!({"field":"process_name","values":[""]})));
        assert!(!process_bound(&json!({"field":"process_path_regex","values":[".*"]})));
        assert!(process_bound(&json!({"op":"any","children":[p.clone(),p]})));
    }
    fn fixture()->AppStore {
        let mut s=AppStore::default();
        let nodes=crate::subscription::parse_single_uri("socks5://127.0.0.1:33301#Fixture",None).unwrap().nodes;
        let sub=serde_json::from_value(json!({"id":"test","name":"test","source":{"kind":"text","content":"fixture"},"last_update":0,"node_count":1,"enabled":true})).unwrap();
        s.upsert_subscription(sub,nodes).unwrap();s.settings.current_node_id=Some(s.nodes[0].node.id.clone());s.settings.selected_apps_only=true;
        let mut apps=RuleSet::new_user("Apps",vec![Rule::new(RuleType::Process,"msedge.exe".into(),RuleTarget::Proxy,10),Rule::new(RuleType::Process,"ChatGPT.exe".into(),RuleTarget::Proxy,20),Rule::new(RuleType::Process,"codex.exe".into(),RuleTarget::Proxy,30),Rule::new(RuleType::DomainSuffix,"riotgames.com".into(),RuleTarget::Proxy,40)]);
        apps.strategy=RuleSetStrategy::Smart;s.rule_sets=vec![crate::domain::build_builtin_remote_set(&crate::domain::BUILTIN_REMOTE_RULE_SETS[0]),apps];s
    }
    #[test] fn all_three_generators_exclude_geography_and_nonprocess_vpn_routes() {
        let s=fixture();let nodes=s.enabled_nodes();let o=crate::runtime::build_options(&s,"fixture".into());
        let sb=crate::config::build_singbox_config(&nodes,&o).unwrap().value;
        assert_eq!(sb["route"]["final"],"direct");assert_eq!(sb["route"]["find_process"],true);
        let projection=options(&o).into_owned();let mut projection=projection;projection.selected_apps_only=false;
        let xr=crate::config::build_xray_config(&nodes,&projection).unwrap().value;
        assert_eq!(xr["routing"]["rules"].as_array().unwrap().last().unwrap()["outboundTag"],"direct");
        let mh=crate::config::build_mihomo_config(&nodes,&o).unwrap().yaml;
        for config in [sb.to_string(),xr.to_string(),mh] {
            assert!(!config.contains("riotgames.com"));assert!(!config.contains("system-geolocation-not-cn"));
            for process in ["msedge.exe","ChatGPT.exe","codex.exe"] {assert!(config.contains(process),"{process}");}
        }
        assert_eq!(s.rule_sets.len(),2,"projection must not mutate saved groups");
    }
    #[test] fn pinned_windows_xray_is_rejected_before_changing_runtime() {
        if !cfg!(target_os="windows") {return}
        let s=fixture();let mut d=crate::routing::Document::from_store(&s);d.core="xray".into();
        assert!(crate::routing::issues(&d,&s).iter().any(|i|i.code=="routing.apps.xray_unavailable"&&i.severity=="error"));
        let opts=crate::runtime::build_options(&s,"fixture".into());
        assert!(crate::config::build_xray_config(&s.enabled_nodes(),&opts).unwrap_err().to_string().contains("routing.apps.xray_unavailable"));
    }
    #[test] fn unlisted_and_unknown_processes_predict_direct() {
        let s=fixture();let d=crate::routing::Document::from_store(&s);
        for process in [None,Some(""),Some("RiotClientServices.exe"),Some("LeagueClient.exe"),Some("explorer.exe"),Some("GameBar.exe")] {
            let q=serde_json::from_value(json!({"destination":"riotgames.com","process":process})).unwrap();
            assert_eq!(crate::routing::predict(&d,&q)["action"],"direct","{process:?}");
        }
        for process in ["msedge.exe","ChatGPT.exe","codex.exe"] {
            let q=serde_json::from_value(json!({"destination":"riotgames.com","process":process})).unwrap();
            assert_eq!(crate::routing::predict(&d,&q)["action"],"proxy");
        }
    }
    #[test] fn discarded_builtin_rules_cannot_reappear_via_legacy_fallback() {
        let s=fixture();let mut opts=crate::runtime::build_options(&s,"fixture".into());
        let rule=Rule::new(RuleType::Process,"unexpected.exe".into(),RuleTarget::Proxy,1);
        let mut builtin=RuleSet::new_user("Builtin",vec![rule.clone()]);builtin.builtin=true;
        opts.rule_sets=vec![builtin];opts.rules=vec![rule];
        let projected=options(&opts);assert!(projected.rule_sets.is_empty());assert!(projected.rules.is_empty());
    }
    #[test] fn retirement_is_a_draft_projection_not_an_automatic_store_change() {
        let s=fixture();let active=crate::routing::Document::from_store(&s);let clean=without_china(&active);
        assert_eq!(active.rule_sets.len(),2);assert_eq!(clean.rule_sets.len(),1);assert_eq!(s.rule_sets.len(),2);
    }
}
