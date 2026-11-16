//! Linked application exceptions live on Rule.routing; expanded rules are never stored.
use crate::{core::CoreKind, domain::{Rule,RuleSet,RuleSetStrategy,RuleTarget}, error::{AppError,AppResult}};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppException {
    pub id:String,
    #[serde(default="enabled")] pub enabled:bool,
    pub scope:String,
    pub domains:Vec<String>,
    pub target:RuleTarget,
}
fn enabled()->bool{true}
fn invalid()->AppError{AppError::Config("routing.exceptions.invalid".into())}
pub fn items(rule:&Rule)->AppResult<Vec<AppException>> {
    let Some(value)=rule.routing.as_ref().and_then(|m|m.get("app_exceptions")) else{return Ok(vec![])};
    let items:Vec<AppException>=serde_json::from_value(value.clone()).map_err(|_|invalid())?;
    if items.len()>64 || (!items.is_empty()&&!super::policy::process_bound(&super::conditions::expression(rule))){return Err(invalid())}
    let mut ids=std::collections::HashSet::new();
    for e in &items {
        if e.id.is_empty()||e.id.len()>128||!ids.insert(&e.id)||!matches!(e.target,RuleTarget::Direct|RuleTarget::Proxy|RuleTarget::Block)||!matches!(e.scope.as_str(),"domain"|"domain_suffix") {return Err(invalid())}
        super::conditions::validate(&json!({"field":e.scope,"values":e.domains}),CoreKind::SingBox,0)?;
    }
    Ok(items)
}
pub fn present(sets:&[RuleSet],rules:&[Rule])->bool {
    sets.iter().flat_map(|s|&s.rules).chain(rules).any(|r|r.routing.as_ref().is_some_and(|v|v.get("app_exceptions").is_some()))
}
pub fn validate(sets:&[RuleSet],rules:&[Rule])->AppResult<()> {
    let mut count=if sets.is_empty(){rules.len()}else{0};
    for set in sets {
        for rule in &set.rules {
            let e=items(rule)?;count+=1+e.len();
            if !e.is_empty()&&(set.remote.is_some()||!matches!(set.strategy,RuleSetStrategy::Smart|RuleSetStrategy::Proxy|RuleSetStrategy::Direct|RuleSetStrategy::Block)){return Err(AppError::Config("routing.exceptions.group".into()))}
        }
    }
    if sets.is_empty(){for rule in rules {count+=items(rule)?.len()}}
    if count>10000{return Err(AppError::Config("routing.draft.too_large".into()))}Ok(())
}
pub fn rules(rules:&[Rule],fixed:Option<RuleTarget>)->Vec<Rule> {
    let mut sorted=rules.to_vec();sorted.sort_by_key(|r|r.ord);
    let mut out=Vec::new();
    for mut parent in sorted {
        let Ok(children)=items(&parent) else {out.push(parent);continue};
        let expr=super::conditions::expression(&parent);
        if let Some(target)=fixed {
            parent.target=target;
            if let Some(m)=parent.routing.as_mut().and_then(Value::as_object_mut){m.remove("pool_id");m.remove("node_ids");m.remove("selection");}
        }
        if let Some(m)=parent.routing.as_mut().and_then(Value::as_object_mut){m.remove("app_exceptions");}
        for child in children {
            let mut rule=parent.clone();rule.id=format!("{}-exception-{}",parent.id,child.id);rule.enabled=parent.enabled&&child.enabled;rule.target=child.target;
            rule.node_id=None;rule.node_name=None;rule.chain_id=None;rule.chain_name=None;rule.smart_include.clear();rule.smart_exclude.clear();
            rule.routing=Some(json!({"name":child.domains.join(", "),"exception_parent":parent.id,"condition":{"op":"all","children":[expr,{"field":child.scope,"values":child.domains}]}}));
            out.push(rule);
        }
        out.push(parent);
    }
    for (i,r) in out.iter_mut().enumerate(){r.ord=((i+1)*10) as i32;}out
}
pub fn sets(sets:&[RuleSet])->Vec<RuleSet> {
    sets.iter().map(|s|{
        if !present(std::slice::from_ref(s),&[]) || s.rules.iter().all(|r|items(r).is_ok_and(|v|v.is_empty())){return s.clone()}
        // Leave invalid metadata intact so the existing validation path rejects it.
        if validate(std::slice::from_ref(s),&[]).is_err(){return s.clone()}
        let mut next=s.clone();next.rules=rules(&s.rules,s.strategy.route_target());next.strategy=RuleSetStrategy::Smart;next
    }).collect()
}

#[cfg(test)]
mod tests {
 use super::*;
 use crate::{domain::RuleType,storage::AppStore};
 fn fixture()->AppStore {
  let mut s=AppStore::default();s.rule_sets.clear();s.settings.bypass_lan=false;s.settings.selected_apps_only=true;
  let mut app=Rule::new(RuleType::Process,"msedge.exe".into(),RuleTarget::Proxy,10);
  app.routing=Some(json!({"name":"Edge","condition":{"field":"process_name","values":["msedge.exe"]},"app_exceptions":[{"id":"sites","enabled":true,"scope":"domain_suffix","domains":["example.com","another.test"],"target":"direct"},{"id":"exact","enabled":true,"scope":"domain","domains":["exact.test"],"target":"block"}]}));
  let mut set=RuleSet::new_user("Applications",vec![app,Rule::new(RuleType::Process,"codex.exe".into(),RuleTarget::Proxy,20),Rule::new(RuleType::Process,"Telegram.exe".into(),RuleTarget::Direct,30),Rule::new(RuleType::Process,"Adguard.exe".into(),RuleTarget::Direct,40)]);set.strategy=RuleSetStrategy::Smart;s.rule_sets.push(set);s
 }
 fn decision(s:&AppStore,process:Option<&str>,domain:&str)->Value {
  super::super::predict(&super::super::Document::from_store(s),&serde_json::from_value(json!({"destination":domain,"process":process})).unwrap())
 }
 #[test] fn app_context_multiple_sites_exact_scope_and_independent_apps() {
  let s=fixture();
  for (p,d,want) in [(Some("msedge.exe"),"example.com","direct"),(Some("msedge.exe"),"sub.example.com","direct"),(Some("msedge.exe"),"another.test","direct"),(Some("msedge.exe"),"other.test","proxy"),(Some("msedge.exe"),"exact.test","block"),(Some("msedge.exe"),"sub.exact.test","proxy"),(Some("codex.exe"),"example.com","proxy"),(Some("Telegram.exe"),"example.com","direct"),(Some("Adguard.exe"),"example.com","direct"),(Some("LeagueClient.exe"),"example.com","direct"),(Some("RiotClientServices.exe"),"example.com","direct"),(None,"example.com","direct")]{assert_eq!(decision(&s,p,d)["action"],want,"{p:?} {d}")}
 }
 #[test] fn tld_suffixes_idna_boundaries_and_app_isolation() {
  let mut s=fixture();s.rule_sets[0].rules[0].routing.as_mut().unwrap()["app_exceptions"]=json!([{"id":"tlds","enabled":true,"scope":"domain_suffix","domains":[".ru",".рф"],"target":"direct"}]);
  for domain in ["example.ru","deep.example.ru","пример.рф","xn--e1afmkfd.xn--p1ai","ПРИМЕР.РФ."]{assert_eq!(decision(&s,Some("msedge.exe"),domain)["action"],"direct","{domain}");assert_eq!(decision(&s,Some("codex.exe"),domain)["action"],"proxy","only Edge may use this exception")}
  for domain in ["guru.com","example.ru.com","guru","notru","example.net"]{assert_eq!(decision(&s,Some("msedge.exe"),domain)["action"],"proxy","{domain}")}
  s.rule_sets[0].rules[0].routing.as_mut().unwrap()["app_exceptions"][0]["domains"]=json!([".com"]);assert_eq!(decision(&s,Some("msedge.exe"),"guru.com")["action"],"direct");assert_eq!(decision(&s,Some("msedge.exe"),"example.ru")["action"],"proxy");
 }
 #[test] fn parent_enable_remove_move_and_serialization_keep_linked_exceptions() {
  let mut s=fixture();let before=serde_json::to_value(&s.rule_sets).unwrap();let restored:Vec<RuleSet>=serde_json::from_value(before.clone()).unwrap();s.rule_sets=restored;
  let generated=sets(&s.rule_sets);assert_eq!(serde_json::to_value(&s.rule_sets).unwrap(),before);assert_eq!(generated[0].rules[0].routing.as_ref().unwrap()["exception_parent"],s.rule_sets[0].rules[0].id);
  s.rule_sets[0].rules[0].enabled=false;assert_eq!(decision(&s,Some("msedge.exe"),"other.test")["action"],"direct");
  assert!(sets(&s.rule_sets)[0].rules.iter().take(3).all(|r|!r.enabled));
  s.rule_sets[0].rules.remove(0);assert!(!sets(&s.rule_sets)[0].rules.iter().any(|r|r.routing.as_ref().is_some_and(|m|m.get("exception_parent").is_some())));
 }
 #[test] fn earlier_rules_win_without_reordering_and_exceptions_precede_parent() {
  let mut s=fixture();assert!(decision(&s,Some("msedge.exe"),"example.com")["rule"].as_str().unwrap().contains("-exception-sites"));
  let mut earlier=Rule::new(RuleType::Process,"msedge.exe".into(),RuleTarget::Block,0);earlier.routing=Some(json!({"name":"Earlier Edge","condition":{"field":"process_name","values":["msedge.exe"]}}));s.rule_sets[0].rules.insert(0,earlier);
  assert_eq!(decision(&s,Some("msedge.exe"),"example.com")["action"],"block");
 }
 #[test] fn fixed_group_keeps_original_parent_exit_but_allows_child_override() {
  let mut s=fixture();s.rule_sets[0].strategy=RuleSetStrategy::Direct;s.rule_sets[0].rules[0].routing.as_mut().unwrap()["app_exceptions"][0]["target"]=json!("proxy");
  assert_eq!(decision(&s,Some("msedge.exe"),"example.com")["action"],"proxy");assert_eq!(decision(&s,Some("msedge.exe"),"other.test")["action"],"direct");assert_eq!(decision(&s,Some("codex.exe"),"other.test")["action"],"direct");
 }
 #[test] fn invalid_url_unbound_parent_and_unsupported_group_fail_explicitly() {
  let mut s=fixture();s.rule_sets[0].rules[0].routing.as_mut().unwrap()["app_exceptions"][0]["domains"]=json!(["https://example.com/account"]);assert!(validate(&s.rule_sets,&[]).is_err());
  let mut s=fixture();s.rule_sets[0].rules[0].routing.as_mut().unwrap()["condition"]=json!({"field":"domain","values":["example.com"]});assert!(validate(&s.rule_sets,&[]).is_err());
  let mut s=fixture();s.rule_sets[0].strategy=RuleSetStrategy::Filter;assert!(validate(&s.rule_sets,&[]).is_err());
 }
 #[test] fn empty_editor_metadata_does_not_change_existing_special_group_strategy() {
  let mut s=fixture();s.rule_sets[0].rules[0].routing.as_mut().unwrap()["app_exceptions"]=json!([]);
  for strategy in [RuleSetStrategy::Node,RuleSetStrategy::Filter,RuleSetStrategy::Chain]{s.rule_sets[0].strategy=strategy;assert_eq!(sets(&s.rule_sets)[0].strategy,strategy)}
 }
 #[test] fn both_supported_generators_compile_the_same_exception_order() {
  let mut s=fixture();let nodes=crate::subscription::parse_single_uri("socks5://127.0.0.1:33301#Fixture",None).unwrap().nodes;s.settings.current_node_id=Some(nodes[0].id.clone());let o=crate::runtime::build_options(&s,"fixture".into());
  let sb=crate::config::build_singbox_config(&nodes,&o).unwrap().value;let mh=crate::config::build_mihomo_config(&nodes,&o).unwrap().yaml;
  assert!(sb.to_string().contains("example.com"));assert!(mh.contains("AND,((PROCESS-NAME,msedge.exe),(DOMAIN-SUFFIX,example.com))")||mh.contains("DOMAIN-SUFFIX,example.com"));
  assert_eq!(sb["route"]["final"],"direct");assert!(mh.contains("MATCH,DIRECT"));
 }
}
