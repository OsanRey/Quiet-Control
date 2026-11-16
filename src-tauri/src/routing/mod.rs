pub mod conditions;
pub mod domains;
pub mod exceptions;
pub mod policy;
use crate::{
    config::BuildOptions,
    core::{manager::CoreManager, CoreKind},
    domain::{OutboundMode, Rule, RuleSet, RuleSetStrategy, RuleTarget},
    error::{AppError, AppResult},
    storage::AppStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub version: u32,
    pub core: String,
    pub mode: OutboundMode,
    pub fallback: String,
    #[serde(default)]
    pub selected_apps_only: bool,
    pub bypass_lan: bool,
    pub find_process: bool,
    pub rule_sets: Vec<RuleSet>,
    pub legacy_rules: Vec<Rule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub base_revision: String,
    pub document: Document,
}
#[derive(Serialize)]
pub struct Issue {
    pub severity: String,
    pub code: String,
    pub set_id: Option<String>,
    pub rule_id: Option<String>,
}
impl Document {
    pub fn from_store(s: &AppStore) -> Self {
        Self {
            version: 1,
            core: s.settings.core_type.clone(),
            mode: s.settings.outbound_mode,
            fallback: s.settings.route_final.clone(),
            selected_apps_only: s.settings.selected_apps_only,
            bypass_lan: s.settings.bypass_lan,
            find_process: s.settings.find_process,
            rule_sets: s.rule_sets.clone(),
            legacy_rules: s.rules.clone(),
        }
    }
    pub fn put(&self, s: &mut AppStore) {
        s.rule_sets = self.rule_sets.iter().filter(|s|!policy::retired_china_set(s)).cloned().collect();
        if s.active_rule_set_id.as_ref().is_some_and(|id|!s.rule_sets.iter().any(|set|&set.id==id)) {
            s.active_rule_set_id=s.rule_sets.first().map(|set|set.id.clone());
        }
        s.rules = self.legacy_rules.clone();
        s.settings.core_type = self.core.clone();
        s.settings.outbound_mode = self.mode;
        s.settings.route_final = if self.selected_apps_only {"direct".into()} else {self.fallback.clone()};
        s.settings.selected_apps_only = self.selected_apps_only;
        s.settings.bypass_lan = self.bypass_lan;
        s.settings.find_process = self.find_process || self.selected_apps_only;
        if self.selected_apps_only {s.settings.outbound_mode = OutboundMode::Rule;}
        s.settings.enforce_multi_core_scope();
    }
    pub fn revision(&self) -> String {
        hex::encode(Sha256::digest(serde_json::to_vec(self).unwrap_or_default()))
    }
}
fn issue(
    out: &mut Vec<Issue>,
    severity: &str,
    code: &str,
    set: Option<&RuleSet>,
    rule: Option<&Rule>,
) {
    out.push(Issue {
        severity: severity.into(),
        code: code.into(),
        set_id: set.map(|s| s.id.clone()),
        rule_id: rule.map(|r| r.id.clone()),
    });
}
/// Only pure domain conditions can safely classify a DNS query. A transport
/// condition must never become a domain merely because legacy payload is filled.
pub fn dns_projection(rules: &[Rule]) -> Vec<Rule> {
    rules
        .iter()
        .flat_map(|rule| {
            if rule
                .routing
                .as_ref()
                .and_then(|m| m.get("condition"))
                .is_none()
            {
                return vec![rule.clone()];
            }
            let expr = conditions::expression(rule);
            let kind = match expr["field"].as_str() {
                Some("domain") => crate::domain::RuleType::Domain,
                Some("domain_suffix") => crate::domain::RuleType::DomainSuffix,
                Some("domain_keyword") => crate::domain::RuleType::DomainKeyword,
                _ => return Vec::new(),
            };
            expr["values"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    v.as_str().map(|payload| {
                        let mut projected = rule.clone();
                        projected.rule_type = kind;
                        projected.payload = payload.into();
                        projected
                    })
                })
                .collect()
        })
        .collect()
}
pub fn issues(d: &Document, store: &AppStore) -> Vec<Issue> {
    let mut out = Vec::new();
    let k = CoreKind::parse(&d.core);
    if cfg!(target_os="windows") && d.selected_apps_only && k == CoreKind::Xray {
        issue(&mut out,"error","routing.apps.xray_unavailable",None,None);
    }
    if d.rule_sets.len() > 1000 || d.rule_sets.iter().map(|s| s.rules.len()).sum::<usize>() > 10000
    {
        issue(&mut out, "error", "routing.draft.too_large", None, None);
        return out;
    }
    if d.selected_apps_only {
        for set in d.rule_sets.iter().filter(|s|s.enabled) {
            if set.builtin || set.remote.is_some() {issue(&mut out,"warning","routing.apps.inactive",Some(set),None);continue;}
            for rule in set.rules.iter().filter(|r|r.enabled && !policy::process_bound(&conditions::expression(r))) {
                issue(&mut out,"warning","routing.apps.inactive",Some(set),Some(rule));
            }
        }
    }
    if let Err(error)=exceptions::validate(&d.rule_sets,&d.legacy_rules) {
        issue(&mut out,"error",&error.to_string().replace("config error: ",""),None,None);return out;
    }
    let scoped = policy::document(d);
    let d = scoped.as_ref();
    if d.version != 1
        || !matches!(d.core.as_str(), "singbox" | "xray" | "mihomo")
        || !matches!(d.fallback.as_str(), "proxy" | "direct" | "block")
    {
        issue(&mut out, "error", "routing.invalid.document", None, None);
        return out;
    }
    let enabled_nodes = store.enabled_nodes();
    let supports = |n: &crate::domain::ProxyNode| {
        k.supports_node(n)
            || (k == CoreKind::SingBox && crate::runtime::node_delegatable(&store.settings, n))
    };
    let mut ids = std::collections::HashSet::new();
    for set in &d.rule_sets {
        if !ids.insert(set.id.clone()) || set.id.is_empty() {
            issue(&mut out, "error", "routing.duplicate.id", Some(set), None)
        }
        if !set.enabled {
            continue;
        }
        let remote = set.remote.as_ref();
        if let Some(remote) = remote {
            if k != CoreKind::SingBox
                && crate::domain::builtin_remote_spec(&set.id)
                    .is_none_or(|spec| spec.url != remote.url)
            {
                issue(
                    &mut out,
                    "error",
                    "routing.remote.incompatible",
                    Some(set),
                    None,
                )
            }
            if k != CoreKind::SingBox
                && !matches!(
                    set.strategy,
                    RuleSetStrategy::Proxy | RuleSetStrategy::Direct | RuleSetStrategy::Block
                )
            {
                issue(
                    &mut out,
                    "error",
                    "routing.remote.action_incompatible",
                    Some(set),
                    None,
                );
            }
            if k == CoreKind::SingBox
                && remote
                    .local_path
                    .as_ref()
                    .is_none_or(|p| !Path::new(p).is_file())
            {
                issue(
                    &mut out,
                    "error",
                    "routing.remote.cache_missing",
                    Some(set),
                    None,
                )
            }
        }
        if set.strategy == RuleSetStrategy::Chain && k != CoreKind::SingBox {
            issue(
                &mut out,
                "error",
                "routing.chain.incompatible",
                Some(set),
                None,
            )
        }
        if set.strategy == RuleSetStrategy::Chain && !valid_chain(store, set.chain_id.as_deref()) {
            issue(&mut out, "error", "routing.chain.missing", Some(set), None)
        }
        if set.strategy == RuleSetStrategy::Node {
            let pins = if set.node_ids.is_empty() {
                set.node_id.clone().into_iter().collect::<Vec<_>>()
            } else {
                set.node_ids.clone()
            };
            if pins.is_empty()
                || pins.iter().any(|id| {
                    enabled_nodes
                        .iter()
                        .find(|n| n.id == *id)
                        .is_none_or(|n| !supports(n))
                })
            {
                issue(&mut out, "error", "routing.node.missing", Some(set), None)
            }
        }
        if set.strategy == RuleSetStrategy::Filter
            && !store.enabled_nodes().iter().any(|n| {
                k.supports_node(n)
                    && crate::domain::name_matches_keywords(
                        &n.name,
                        &set.smart_include,
                        &set.smart_exclude,
                    )
            })
        {
            issue(&mut out, "error", "routing.pool.empty", Some(set), None)
        }
        let mut seen = std::collections::HashMap::new();
        let mut earlier_domains: Vec<(String, String)> = Vec::new();
        let mut sorted = set.rules.iter().filter(|r| r.enabled).collect::<Vec<_>>();
        sorted.sort_by_key(|r| r.ord);
        for rule in sorted {
            if rule.id.is_empty() || !ids.insert(format!("{}:{}", set.id, rule.id)) {
                issue(
                    &mut out,
                    "error",
                    "routing.duplicate.id",
                    Some(set),
                    Some(rule),
                )
            }
            let expr = conditions::expression(rule);
            if k != CoreKind::SingBox
                && rule
                    .routing
                    .as_ref()
                    .and_then(|m| m.get("condition"))
                    .is_some()
                && dns_projection(std::slice::from_ref(rule)).is_empty()
            {
                issue(
                    &mut out,
                    "warning",
                    "routing.dns.explicit_only",
                    Some(set),
                    Some(rule),
                );
            }
            if let Err(e) = conditions::validate(&expr, k, 0) {
                issue(
                    &mut out,
                    "error",
                    &e.to_string().replace("config error: ", ""),
                    Some(set),
                    Some(rule),
                )
            }
            if rule.payload.trim().is_empty() {
                issue(
                    &mut out,
                    "error",
                    "routing.condition.value",
                    Some(set),
                    Some(rule),
                )
            }
            if let Some(pool) = rule
                .routing
                .as_ref()
                .and_then(|m| m.get("pool_id"))
                .and_then(Value::as_str)
            {
                if let Some(p) = store.pools.iter().find(|p| p.id == pool) {
                    let members: Vec<_> = match &p.mode {
                        crate::domain::PoolMode::Explicit { node_ids } => enabled_nodes
                            .iter()
                            .filter(|n| node_ids.contains(&n.id) && supports(n))
                            .collect(),
                        crate::domain::PoolMode::Keyword { include, exclude } => enabled_nodes
                            .iter()
                            .filter(|n| {
                                supports(n)
                                    && crate::domain::name_matches_keywords(
                                        &n.name, include, exclude,
                                    )
                            })
                            .collect(),
                    };
                    if members.is_empty() {
                        issue(
                            &mut out,
                            "error",
                            "routing.pool.empty",
                            Some(set),
                            Some(rule),
                        )
                    }
                } else {
                    issue(
                        &mut out,
                        "error",
                        "routing.pool.missing",
                        Some(set),
                        Some(rule),
                    )
                }
            }
            if set.strategy == RuleSetStrategy::Smart {
                if rule.target == RuleTarget::Node
                    && rule.node_id.as_ref().is_none_or(|id| {
                        enabled_nodes
                            .iter()
                            .find(|n| n.id == *id)
                            .is_none_or(|n| !supports(n))
                    })
                {
                    issue(
                        &mut out,
                        "error",
                        "routing.node.missing",
                        Some(set),
                        Some(rule),
                    )
                }
                if rule.target == RuleTarget::Chain {
                    if k != CoreKind::SingBox {
                        issue(
                            &mut out,
                            "error",
                            "routing.chain.incompatible",
                            Some(set),
                            Some(rule),
                        )
                    }
                    if !valid_chain(store, rule.chain_id.as_deref()) {
                        issue(
                            &mut out,
                            "error",
                            "routing.chain.missing",
                            Some(set),
                            Some(rule),
                        )
                    }
                }
                if rule.target == RuleTarget::Smart
                    && rule
                        .routing
                        .as_ref()
                        .and_then(|m| m.get("pool_id"))
                        .is_none()
                    && !store.enabled_nodes().iter().any(|n| {
                        k.supports_node(n)
                            && crate::domain::name_matches_keywords(
                                &n.name,
                                &rule.smart_include,
                                &rule.smart_exclude,
                            )
                    })
                {
                    issue(
                        &mut out,
                        "error",
                        "routing.pool.empty",
                        Some(set),
                        Some(rule),
                    )
                }
            }
            if let (Some(field), Some(value)) = (
                expr["field"].as_str(),
                expr["values"]
                    .as_array()
                    .and_then(|a| if a.len() == 1 { a[0].as_str() } else { None }),
            ) {
                if matches!(field, "domain" | "domain_suffix") {
                    if earlier_domains.iter().any(|(f, v)| {
                        f == "domain_suffix" && (value == v || value.ends_with(&format!(".{v}")))
                    }) {
                        issue(
                            &mut out,
                            "warning",
                            "routing.rule.shadowed",
                            Some(set),
                            Some(rule),
                        )
                    }
                    earlier_domains.push((field.into(), value.into()));
                }
            }
            let signature = expr.to_string();
            if seen.insert(signature, rule.id.clone()).is_some() {
                issue(
                    &mut out,
                    "warning",
                    "routing.rule.duplicate",
                    Some(set),
                    Some(rule),
                )
            }
            if expr.to_string().contains("process_") {
                issue(
                    &mut out,
                    "warning",
                    if store.settings.capture_mode == crate::domain::CaptureMode::Tun
                        && d.find_process
                    {
                        "routing.process.best_effort"
                    } else {
                        "routing.process.limited"
                    },
                    Some(set),
                    Some(rule),
                )
            }
            if expr.to_string().contains("domain") {
                issue(
                    &mut out,
                    "warning",
                    "routing.domain.metadata",
                    Some(set),
                    Some(rule),
                )
            }
            if set.strategy != RuleSetStrategy::Smart
                && rule.target != set.strategy.route_target().unwrap_or(rule.target)
            {
                issue(
                    &mut out,
                    "warning",
                    "routing.group.overrides",
                    Some(set),
                    Some(rule),
                )
            }
        }
    }
    if d.mode != OutboundMode::Rule {
        issue(&mut out, "warning", "routing.mode.bypasses", None, None)
    }
    out
}
pub fn ensure(d: &Document, s: &AppStore) -> AppResult<()> {
    let errors = issues(d, s)
        .into_iter()
        .filter(|i| i.severity == "error")
        .map(|i| {
            format!(
                "{} [{}]",
                i.code,
                i.rule_id.or(i.set_id).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::Config(errors.join("\n")))
    }
}
pub fn validate_options(opts: &BuildOptions, k: CoreKind) -> AppResult<()> {
    // Pinned Xray 26.3.27 only creates Wintun; it ignores automatic OS routes.
    // Refuse a promise of per-app capture instead of silently bypassing the VPN.
    if cfg!(target_os="windows") && opts.selected_apps_only && k == CoreKind::Xray {
        return Err(AppError::Config("routing.apps.xray_unavailable".into()));
    }
    for rule in opts
        .rules
        .iter()
        .chain(
            opts.rule_sets
                .iter()
                .filter(|s| s.enabled)
                .flat_map(|s| s.rules.iter()),
        )
        .filter(|r| r.enabled && r.routing.is_some())
    {
        conditions::validate(&conditions::expression(rule), k, 0)?;
        if rule.target == RuleTarget::Smart
            && rule
                .routing
                .as_ref()
                .and_then(|m| m.get("pool_id"))
                .is_some()
        {
            if rule
                .routing
                .as_ref()
                .and_then(|m| m.get("selection"))
                .and_then(Value::as_str)
                != Some("kernel")
            {
                return Err(AppError::Config("routing.pool.selection".into()));
            }
            if rule
                .routing
                .as_ref()
                .and_then(|m| m.get("node_ids"))
                .and_then(Value::as_array)
                .is_none_or(|ids| ids.is_empty())
            {
                return Err(AppError::Config("routing.pool.empty".into()));
            }
        }
    }
    Ok(())
}
/// Exact shared generator options, including the existing sidecar plan. No downloads.
pub fn build(store: &AppStore, without_tun: bool) -> AppResult<String> {
    let nodes = store.enabled_nodes();
    let mut opts = crate::runtime::build_options(
        store,
        store.settings.clash_api_secret.clone().unwrap_or_default(),
    );
    if without_tun {
        opts.tun_enabled = false;
    }
    opts.sidecar = crate::runtime::compute_sidecar_plan(&store.settings, &store.chains, &nodes);
    match CoreKind::parse(&store.settings.core_type) {
        CoreKind::SingBox => Ok(serde_json::to_string_pretty(
            &crate::config::build_singbox_config(&nodes, &opts)?.value,
        )
        .map_err(|e| AppError::Config(e.to_string()))?),
        CoreKind::Xray => Ok(serde_json::to_string_pretty(
            &crate::config::build_xray_config(&nodes, &opts)?.value,
        )
        .map_err(|e| AppError::Config(e.to_string()))?),
        CoreKind::Mihomo => Ok(crate::config::build_mihomo_config(&nodes, &opts)?.yaml),
    }
}
/// Check a no-TUN projection: Xray -test with a real TUN is not side-effect free.
/// Cache/geodata remains local; no new source is downloaded by this path.
pub fn preflight(store: &AppStore, app_dir: &Path, resources: Option<&Path>) -> AppResult<()> {
    let kind = CoreKind::parse(&store.settings.core_type);
    let (binary, _) = crate::core::inspect_core_bin(app_dir, resources, kind);
    let bin = binary.ok_or_else(|| AppError::Config("routing.core.missing".into()))?;
    let text = build(store, true)?;
    let dir = app_dir.join("config");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(if kind == CoreKind::Mihomo {
        "routing-preflight.yaml"
    } else {
        "routing-preflight.json"
    });
    std::fs::write(&path, text)?;
    let checked = CoreManager::check_config(kind, &bin, &path);
    let _ = std::fs::remove_file(path);
    checked
}
pub fn read_draft(app_dir: &Path) -> AppResult<Option<Draft>> {
    let p = app_dir.join("data/routing-draft.json");
    if !p.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(p)?;
    Ok(Some(serde_json::from_slice(&bytes).map_err(|e| {
        AppError::Config(format!("routing.draft.read: {e}"))
    })?))
}
pub fn write_draft(app_dir: &Path, draft: &Draft) -> AppResult<()> {
    let p = app_dir.join("data/routing-draft.json");
    if serde_json::to_vec(draft)
        .map_err(|e| AppError::Config(e.to_string()))?
        .len()
        > 4 * 1024 * 1024
    {
        return Err(AppError::Config("routing.draft.too_large".into()));
    }
    std::fs::create_dir_all(p.parent().unwrap())?;
    crate::storage::replace_file(
        &p,
        &serde_json::to_vec_pretty(draft).map_err(|e| AppError::Config(e.to_string()))?,
    )?;
    Ok(())
}

#[derive(Deserialize)]
pub struct Query {
    pub destination: String,
    pub process: Option<String>,
    pub port: Option<u16>,
    pub network: Option<String>,
    pub inbound: Option<String>,
}
fn ip_contains(cidr: &str, value: &str) -> Option<bool> {
    let value = value.parse::<std::net::IpAddr>().ok()?;
    let (base, prefix) = cidr
        .split_once('/')
        .map(|(a, b)| (a, b.parse::<u8>().ok()))
        .unwrap_or((cidr, None));
    let base = base.parse::<std::net::IpAddr>().ok()?;
    Some(match (base, value) {
        (std::net::IpAddr::V4(a), std::net::IpAddr::V4(b)) => {
            let p = prefix.unwrap_or(32);
            p == 0 || (u32::from(a) >> (32 - p)) == (u32::from(b) >> (32 - p))
        }
        (std::net::IpAddr::V6(a), std::net::IpAddr::V6(b)) => {
            let p = prefix.unwrap_or(128);
            p == 0 || (u128::from(a) >> (128 - p)) == (u128::from(b) >> (128 - p))
        }
        _ => false,
    })
}
fn matches(v: &Value, q: &Query) -> Option<bool> {
    if let Some(op) = v["op"].as_str() {
        let vals = v["children"]
            .as_array()?
            .iter()
            .map(|v| matches(v, q))
            .collect::<Vec<_>>();
        return match op {
            "not" => vals[0].map(|b| !b),
            "all" => {
                if vals.contains(&Some(false)) {
                    Some(false)
                } else if vals.contains(&None) {
                    None
                } else {
                    Some(true)
                }
            }
            _ => {
                if vals.contains(&Some(true)) {
                    Some(true)
                } else if vals.contains(&None) {
                    None
                } else {
                    Some(false)
                }
            }
        };
    }
    let field = v["field"].as_str()?;
    let mut unknown = false;
    for value in v["values"].as_array()? {
        let value = value.as_str()?;
        let dest = q.destination.trim_end_matches('.').to_lowercase();
        let hit = match field {
            "domain" => {
                if dest.parse::<std::net::IpAddr>().is_ok() {
                    None
                } else {
                    Some(domains::normalize(&dest,false).ok()? == domains::normalize(value,false).ok()?)
                }
            }
            "domain_suffix" => {
                if dest.parse::<std::net::IpAddr>().is_ok() {
                    None
                } else {
                    let d = domains::normalize(value,true).ok()?;
                    let dest=domains::normalize(&dest,false).ok()?;
                    Some(dest == d || dest.ends_with(&format!(".{d}")))
                }
            }
            "domain_keyword" => {
                if dest.parse::<std::net::IpAddr>().is_ok() {
                    None
                } else {
                    Some(dest.contains(&value.to_lowercase()))
                }
            }
            "ip_cidr" => ip_contains(value, &dest),
            "process_name" => q
                .process
                .as_ref()
                .map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p) == value),
            "process_path" => q.process.as_ref().map(|p| p == value),
            "port" => q.port.map(|p| {
                let parts = value.split(['-', ':']).collect::<Vec<_>>();
                let lo = parts[0].parse::<u16>().unwrap_or(0);
                let hi = parts.last().unwrap().parse::<u16>().unwrap_or(0);
                p >= lo && p <= hi
            }),
            "network" => q.network.as_ref().map(|n| n == value),
            "inbound" => q.inbound.as_ref().map(|n| n == value),
            _ => None,
        };
        if hit == Some(true) {
            return Some(true);
        }
        if hit.is_none() {
            unknown = true
        }
    }
    if unknown {
        None
    } else {
        Some(false)
    }
}
pub fn predict(d: &Document, q: &Query) -> Value {
    if exceptions::validate(&d.rule_sets,&d.legacy_rules).is_err(){return json!({"certainty":"unknown","reason":"routing.exceptions.invalid","observed":false})}
    let scoped = policy::document(d);
    let d = scoped.as_ref();
    if d.mode == OutboundMode::Rule
        && d.bypass_lan
        && [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "::1/128",
            "fc00::/7",
            "fe80::/10",
        ]
        .iter()
        .any(|r| ip_contains(r, &q.destination) == Some(true))
    {
        return json!({"certainty":"static","action":"direct","reason":"routing.predict.lan","observed":false});
    }
    if q.port == Some(53) {
        return json!({"certainty":"unknown","reason":"routing.predict.dns","observed":false});
    }
    if d.selected_apps_only && q.process.as_deref().is_none_or(|p| p.trim().is_empty()) {
        return json!({"certainty":"fallback","action":"direct","reason":"routing.predict.unidentified","observed":false});
    }
    if d.mode != OutboundMode::Rule {
        return json!({"certainty":"mode","action":if d.mode==OutboundMode::Direct{"direct"}else{"proxy"},"core":d.core,"observed":false});
    }
    for set in d.rule_sets.iter().filter(|s| s.enabled) {
        if set.remote.is_some() {
            return json!({"certainty":"unknown","set":set.id,"reason":"routing.predict.remote","observed":false});
        }
        let mut rules = set.rules.iter().filter(|r| r.enabled).collect::<Vec<_>>();
        rules.sort_by_key(|r| r.ord);
        for rule in rules {
            match matches(&conditions::expression(rule), q) {
                Some(false) => continue,
                hit => {
                    return json!({"certainty":if hit.is_some(){"static"}else{"unknown"},"set":set.id,"rule":rule.id,"rule_name":rule.routing.as_ref().and_then(|m|m.get("name")),"parent_rule":rule.routing.as_ref().and_then(|m|m.get("exception_parent")),"priority":"routing.priority.first_match","action":match set.strategy {RuleSetStrategy::Smart=>rule.target,RuleSetStrategy::Node=>if set.node_ids.len()>1{RuleTarget::Smart}else{RuleTarget::Node},RuleSetStrategy::Filter=>RuleTarget::Smart,RuleSetStrategy::Chain=>RuleTarget::Chain,_=>set.strategy.route_target().unwrap_or(rule.target)},"node":set.node_id.as_ref().or(rule.node_id.as_ref()),"chain":set.chain_id.as_ref().or(rule.chain_id.as_ref()),"core":d.core,"observed":false})
                }
            }
        }
    }
    json!({"certainty":"fallback","action":d.fallback,"core":d.core,"observed":false})
}

pub fn materialize_pools(opts: &mut BuildOptions, store: &AppStore) {
    for r in opts
        .rules
        .iter_mut()
        .chain(opts.rule_sets.iter_mut().flat_map(|s| s.rules.iter_mut()))
    {
        let id = r
            .routing
            .as_ref()
            .and_then(|m| m.get("pool_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(id) = id {
            let ids = store
                .pools
                .iter()
                .find(|p| p.id == id)
                .map(|p| match &p.mode {
                    crate::domain::PoolMode::Explicit { node_ids } => node_ids.clone(),
                    crate::domain::PoolMode::Keyword { include, exclude } => store
                        .enabled_nodes()
                        .into_iter()
                        .filter(|n| crate::domain::name_matches_keywords(&n.name, include, exclude))
                        .map(|n| n.id)
                        .collect(),
                })
                .unwrap_or_default();
            if let Some(m) = r.routing.as_mut().and_then(Value::as_object_mut) {
                m.insert("node_ids".into(), json!(ids));
            }
        }
    }
}

pub fn validate_sources(d: &Document, store: &AppStore, app_dir: &Path) -> AppResult<()> {
    let clean = policy::without_china(d);
    let scoped = policy::document(&clean);
    let d = scoped.as_ref();
    for set in d.rule_sets.iter().filter(|s| s.enabled) {
        if let Some(remote) = &set.remote {
            if let Some(path) = &remote.local_path {
                let path = std::fs::canonicalize(path)?;
                let managed = [
                    app_dir.join("routing-cache"),
                    app_dir.join("remote-rule-sets"),
                ]
                .iter()
                .filter_map(|p| std::fs::canonicalize(p).ok())
                .any(|p| path.starts_with(p));
                let original = store
                    .rule_sets
                    .iter()
                    .find(|s| s.id == set.id)
                    .and_then(|s| s.remote.as_ref());
                let retained = original
                    .is_some_and(|r| r.url == remote.url && r.local_path == remote.local_path);
                if !managed && !retained {
                    return Err(AppError::Config("routing.source.path".into()));
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests;

fn valid_chain(store: &AppStore, id: Option<&str>) -> bool {
    let nodes = store.enabled_nodes();
    let Some(chain) = store.chains.iter().find(|c| Some(c.id.as_str()) == id) else {
        return false;
    };
    !chain.hops.is_empty()
        && chain.hops.iter().all(|hop| match hop {
            crate::domain::ChainHop::Node { node_id } => nodes
                .iter()
                .any(|n| n.id == *node_id && CoreKind::SingBox.supports_node(n)),
            crate::domain::ChainHop::Pool { pool_id } => store
                .pools
                .iter()
                .find(|p| p.id == *pool_id)
                .is_some_and(|p| match &p.mode {
                    crate::domain::PoolMode::Explicit { node_ids } => nodes
                        .iter()
                        .any(|n| node_ids.contains(&n.id) && CoreKind::SingBox.supports_node(n)),
                    crate::domain::PoolMode::Keyword { include, exclude } => {
                        nodes.iter().any(|n| {
                            CoreKind::SingBox.supports_node(n)
                                && crate::domain::name_matches_keywords(&n.name, include, exclude)
                        })
                    }
                }),
        })
}
