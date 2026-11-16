use super::*;
use crate::domain::RuleType;
fn fixture() -> AppStore {
    let mut store = AppStore::default();
    let sub=serde_json::from_value(json!({"id":"fixture","name":"Controlled fixture","source":{"kind":"file","path":"fixture.txt"},"last_update":0,"node_count":2,"enabled":true})).unwrap();
    let a = crate::subscription::parse_single_uri("socks5://127.0.0.1:33301#Fixture-A", None)
        .unwrap()
        .nodes;
    let b = crate::subscription::parse_single_uri("socks5://127.0.0.1:33302#Fixture-B", None)
        .unwrap()
        .nodes;
    store.upsert_subscription(sub, a.into_iter().chain(b).collect());
    store.settings.current_node_id = Some(store.enabled_nodes()[0].id.clone());
    store.settings.outbound_mode = OutboundMode::Rule;
    store.settings.route_final = "direct".into();
    store.settings.mixed_port = 32189;
    store.settings.bypass_lan = false;
    store.rule_sets.clear();
    store
}
fn rule(field: &str, value: &str, target: RuleTarget, ord: i32) -> Rule {
    let mut r = Rule::new(RuleType::Domain, value.into(), target, ord);
    r.routing = Some(
        json!({"name":format!("{field}: {value}"),"condition":{"field":field,"values":[value]}}),
    );
    r
}
#[test]
fn three_generators_compile_conditions_actions_fallback() {
    let mut store = fixture();
    let mut set = RuleSet::new_user(
        "Fixture",
        vec![
            rule("domain_suffix", "proxy.test", RuleTarget::Proxy, 10),
            rule("domain", "direct.test", RuleTarget::Direct, 20),
            rule("ip_cidr", "127.0.0.2/32", RuleTarget::Block, 30),
            rule("process_name", "client.exe", RuleTarget::Direct, 40),
            rule("ip_cidr", "2001:db8::/32", RuleTarget::Block, 50),
        ],
    );
    set.strategy = RuleSetStrategy::Smart;
    store.rule_sets.push(set);
    for core in ["singbox", "xray", "mihomo"] {
        store.settings.core_type = core.into();
        let text = build(&store, true).unwrap();
        assert!(text.contains("proxy.test"));
        assert!(text.contains("direct.test"));
        assert!(text.contains("client.exe"));
        assert!(text.contains("2001:db8::/32"));
        assert!(text.contains(if core == "mihomo" {
            "REJECT"
        } else if core == "xray" {
            "block"
        } else {
            "reject"
        }));
        if let Ok(dir) = std::env::var("QC_ROUTING_FIXTURE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                Path::new(&dir).join(format!(
                    "{core}.{}",
                    if core == "mihomo" { "yaml" } else { "json" }
                )),
                text,
            )
            .unwrap();
        }
    }
}
#[test]
fn singbox_preserves_non_adjacent_action_priority() {
    let mut s = fixture();
    let mut set = RuleSet::new_user(
        "Priority",
        vec![
            rule("domain", "first.test", RuleTarget::Direct, 10),
            rule("domain_suffix", "example.test", RuleTarget::Block, 20),
            rule("domain", "video.example.test", RuleTarget::Direct, 30),
        ],
    );
    set.strategy = RuleSetStrategy::Smart;
    let id = set.id.clone();
    s.rule_sets.push(set);
    let v: Value = serde_json::from_str(&build(&s, true).unwrap()).unwrap();
    let routes = v["route"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["rule_set"].to_string().contains(&id))
        .collect::<Vec<_>>();
    assert_eq!(routes.len(), 3, "A/B/A must remain three priority runs");
    assert_eq!(routes[1]["action"], "reject");
}
#[test]
fn condition_compiler_distinguishes_engines() {
    let all = json!({"op":"all","children":[{"field":"domain_suffix","values":["example.test"]},{"field":"port","values":["443","8000-8010"]}]});
    for k in [CoreKind::SingBox, CoreKind::Xray, CoreKind::Mihomo] {
        conditions::validate(&all, k, 0).unwrap();
    }
    assert_eq!(conditions::xray(&all)["port"], "443,8000-8010");
    assert!(conditions::mihomo(&all).starts_with("AND,"));
    assert_eq!(conditions::singbox(&all)["type"], "logical");
    let not = json!({"op":"not","children":[{"field":"network","values":["udp"]}]});
    assert!(conditions::validate(&not, CoreKind::Xray, 0).is_err());
    assert!(conditions::validate(&not, CoreKind::SingBox, 0).is_ok());
    assert!(conditions::validate(&not, CoreKind::Mihomo, 0).is_ok());
}
#[test]
fn malformed_input_and_missing_references_are_rejected() {
    for (f, v) in [
        ("ip_cidr", "127.0.0.1/65"),
        ("ip_cidr", "::/129"),
        ("port", "0"),
        ("port", "70000"),
        ("port", "443-80"),
        ("network", "quic"),
        ("domain", "https://example.com"),
    ] {
        assert!(
            conditions::validate(&json!({"field":f,"values":[v]}), CoreKind::SingBox, 0).is_err(),
            "{f} {v}"
        );
    }
    let mut s = fixture();
    let mut r = rule("domain", "a.test", RuleTarget::Node, 10);
    r.node_id = Some("deleted".into());
    let mut set = RuleSet::new_user("Bad", vec![r]);
    set.strategy = RuleSetStrategy::Smart;
    s.rule_sets.push(set);
    assert!(ensure(&Document::from_store(&s), &s).is_err());
}
#[test]
fn incompatible_rules_survive_core_switch_serialization() {
    let mut s = fixture();
    let mut r = rule("domain", "a.test", RuleTarget::Chain, 10);
    r.chain_id = Some("deleted-chain".into());
    let id = r.id.clone();
    let mut set = RuleSet::new_user("Chain", vec![r]);
    set.strategy = RuleSetStrategy::Smart;
    s.rule_sets.push(set);
    let mut d = Document::from_store(&s);
    d.core = "xray".into();
    assert!(issues(&d, &s)
        .iter()
        .any(|i| i.code == "routing.chain.incompatible"));
    let restored: Document = serde_json::from_slice(&serde_json::to_vec(&d).unwrap()).unwrap();
    assert_eq!(restored.rule_sets[0].rules[0].id, id);
    assert_eq!(restored.rule_sets[0].rules[0].target, RuleTarget::Chain);
}
#[test]
fn static_prediction_handles_unknown_and_first_match() {
    let mut s = fixture();
    let mut set = RuleSet::new_user(
        "Rules",
        vec![
            rule("domain_suffix", "example.test", RuleTarget::Block, 10),
            rule("domain", "video.example.test", RuleTarget::Direct, 20),
        ],
    );
    set.strategy = RuleSetStrategy::Smart;
    s.rule_sets.push(set);
    let d = Document::from_store(&s);
    let q = Query {
        destination: "video.example.test".into(),
        process: None,
        port: Some(443),
        network: Some("tcp".into()),
        inbound: None,
    };
    assert_eq!(predict(&d, &q)["action"], "block");
    let q = Query {
        destination: "1.2.3.4".into(),
        ..q
    };
    assert_eq!(predict(&d, &q)["certainty"], "unknown");
}
#[test]
fn draft_is_separate_from_store_and_roundtrips() {
    let s = fixture();
    let original = Document::from_store(&s);
    let mut d = original.clone();
    d.fallback = "block".into();
    assert_ne!(d.revision(), original.revision());
    assert_eq!(s.settings.route_final, "direct");
    let draft = Draft {
        base_revision: original.revision(),
        document: d,
    };
    let result: Draft = serde_json::from_slice(&serde_json::to_vec(&draft).unwrap()).unwrap();
    assert_eq!(result.document.fallback, "block");
    assert_eq!(result.base_revision, original.revision());
}

#[test]
fn advanced_conditions_do_not_fabricate_dns_domains() {
    let mut s = fixture();
    let mut domains = rule("domain", "first.test", RuleTarget::Direct, 10);
    domains.routing.as_mut().unwrap()["condition"]["values"] = json!(["first.test", "second.test"]);
    let process = rule("process_name", "client.exe", RuleTarget::Direct, 20);
    let port = rule("port", "443", RuleTarget::Direct, 30);
    let mut set = RuleSet::new_user("DNS projection", vec![domains, process, port]);
    set.strategy = RuleSetStrategy::Smart;
    let projected = dns_projection(&set.rules);
    assert_eq!(
        projected
            .iter()
            .map(|r| r.payload.as_str())
            .collect::<Vec<_>>(),
        vec!["first.test", "second.test"]
    );
    s.rule_sets.push(set);
    for core in ["xray", "mihomo"] {
        s.settings.core_type = core.into();
        let text = build(&s, true).unwrap();
        let dns = if core == "xray" {
            serde_json::from_str::<Value>(&text).unwrap()["dns"].to_string()
        } else {
            serde_yaml::to_string(&serde_yaml::from_str::<serde_yaml::Value>(&text).unwrap()["dns"])
                .unwrap()
        };
        assert!(
            dns.contains("first.test") && dns.contains("second.test"),
            "{core}: {dns}"
        );
        assert!(
            !dns.contains("client.exe"),
            "process must not become a DNS domain: {core}"
        );
    }
}

#[test]
fn builtin_remote_identity_and_action_must_match_adapter() {
    let mut s = fixture();
    s.rule_sets = vec![crate::domain::build_builtin_remote_set(
        &crate::domain::BUILTIN_REMOTE_RULE_SETS[0],
    )];
    let mut d = Document::from_store(&s);
    d.core = "xray".into();
    let set = d.rule_sets.iter_mut().find(|s| s.remote.is_some()).unwrap();
    set.enabled = true;
    set.remote.as_mut().unwrap().url = "https://example.invalid/custom.srs".into();
    set.strategy = RuleSetStrategy::Node;
    let codes = issues(&d, &s)
        .into_iter()
        .map(|i| i.code)
        .collect::<Vec<_>>();
    assert!(codes.iter().any(|c| c == "routing.remote.incompatible"));
    assert!(codes
        .iter()
        .any(|c| c == "routing.remote.action_incompatible"));
}
