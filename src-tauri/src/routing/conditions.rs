//! Quiet Control routing adapter: conditions only; existing generators own exits,
//! DNS, TUN protection and outbound/group construction.
use crate::{
    core::CoreKind,
    domain::{Rule, RuleType},
    error::{AppError, AppResult},
};
use serde_json::{json, Map, Value};

pub fn expression(rule: &Rule) -> Value {
    rule.routing.as_ref().and_then(|x|x.get("condition")).filter(|x|!x.is_null()).cloned()
        .unwrap_or_else(||json!({"field":match rule.rule_type {RuleType::Process=>"process_name",other=>other.as_str()},"values":[rule.payload]}))
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::Config(message.into())
}
pub fn port(value: &str) -> bool {
    let p: Vec<_> = value.split(['-', ':']).collect();
    !p.is_empty()
        && p.len() <= 2
        && p.iter().all(|p| p.parse::<u16>().is_ok_and(|n| n > 0))
        && (p.len() == 1 || p[0].parse::<u16>().unwrap() <= p[1].parse::<u16>().unwrap())
}
pub fn cidr(value: &str) -> bool {
    let (ip, mask) = value
        .split_once('/')
        .map(|(a, b)| (a, Some(b)))
        .unwrap_or((value, None));
    let Ok(ip) = ip.parse::<std::net::IpAddr>() else {
        return false;
    };
    mask.is_none_or(|m| {
        m.parse::<u8>()
            .is_ok_and(|n| n <= if ip.is_ipv4() { 32 } else { 128 })
    })
}
pub fn validate(v: &Value, kind: CoreKind, depth: usize) -> AppResult<()> {
    if depth > 8 {
        return Err(invalid("routing.condition.depth"));
    }
    if let Some(op) = v.get("op").and_then(Value::as_str) {
        let children = v
            .get("children")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("routing.condition.children"))?;
        if children.is_empty()
            || children.len() > 64
            || !matches!(op, "all" | "any" | "not")
            || op == "not" && children.len() != 1
        {
            return Err(invalid("routing.condition.logic"));
        }
        if kind == CoreKind::Xray && op != "all" {
            return Err(invalid("routing.xray.logic"));
        }
        let mut keys = std::collections::HashSet::new();
        for child in children {
            validate(child, kind, depth + 1)?;
            if kind == CoreKind::Xray {
                let field = child
                    .get("field")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("routing.xray.nested"))?;
                let key = xray_key(field).ok_or_else(|| invalid("routing.condition.field"))?;
                if !keys.insert(key) {
                    return Err(invalid("routing.xray.same_field"));
                }
            }
        }
        return Ok(());
    }
    let field = v
        .get("field")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("routing.condition.field"))?;
    let values = v
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("routing.condition.values"))?;
    if values.is_empty() || values.len() > 1000 {
        return Err(invalid("routing.condition.values"));
    }
    if !matches!(
        field,
        "domain"
            | "domain_suffix"
            | "domain_keyword"
            | "domain_regex"
            | "ip_cidr"
            | "source_ip_cidr"
            | "process_name"
            | "process_path"
            | "port"
            | "source_port"
            | "network"
            | "inbound"
    ) {
        return Err(invalid("routing.condition.field"));
    }
    if kind == CoreKind::Xray && field == "process_path" {
        return Err(invalid("routing.xray.process_path"));
    }
    for value in values {
        let s = value
            .as_str()
            .ok_or_else(|| invalid("routing.condition.string"))?;
        if s.trim().is_empty() || s.len() > 2048 || s.contains(['\n', '\r', '\0']) {
            return Err(invalid("routing.condition.value"));
        }
        if kind == CoreKind::Mihomo && s.contains([',', '(', ')']) {
            return Err(invalid("routing.mihomo.delimiter"));
        }
        if matches!(field, "ip_cidr" | "source_ip_cidr") && !cidr(s) {
            return Err(invalid("routing.invalid.cidr"));
        }
        if matches!(field, "port" | "source_port") && !port(s) {
            return Err(invalid("routing.invalid.port"));
        }
        if field == "network" && !matches!(s, "tcp" | "udp") {
            return Err(invalid("routing.invalid.network"));
        }
        if matches!(field,"domain"|"domain_suffix") {
            super::domains::normalize(s,field=="domain_suffix")?;
        }
        if field == "process_path" && !std::path::Path::new(s).is_absolute() {
            return Err(invalid("routing.invalid.path"));
        }
    }
    Ok(())
}
fn xray_key(field: &str) -> Option<&'static str> {
    Some(match field {
        "domain" | "domain_suffix" | "domain_keyword" | "domain_regex" => "domain",
        "ip_cidr" => "ip",
        "source_ip_cidr" => "source",
        "process_name" => "process",
        "port" => "port",
        "source_port" => "sourcePort",
        "network" => "network",
        "inbound" => "inboundTag",
        _ => return None,
    })
}
pub fn singbox(v: &Value) -> Value {
    if let Some(op) = v["op"].as_str() {
        let children: Vec<Value> = v["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(singbox)
            .collect();
        return json!({"type":"logical","mode":if op=="any"{"or"}else{"and"},"invert":op=="not","rules":children});
    }
    let field = v["field"].as_str().unwrap();
    let values = v["values"].as_array().unwrap();
    let mut o = Map::new();
    if matches!(field, "port" | "source_port") {
        let mut singles = Vec::new();
        let mut ranges = Vec::new();
        for s in values {
            let s = s.as_str().unwrap();
            if s.contains(['-', ':']) {
                ranges.push(s.replace('-', ":"))
            } else {
                singles.push(s.parse::<u16>().unwrap())
            }
        }
        if !singles.is_empty() {
            o.insert(field.into(), json!(singles));
        }
        if !ranges.is_empty() {
            o.insert(format!("{field}_range"), json!(ranges));
        }
    } else {
        o.insert(
            field.into(),
            if matches!(field, "domain" | "domain_suffix") {
                json!(values
                    .iter()
                    .map(|v| super::domains::normalize(v.as_str().unwrap(),field=="domain_suffix").unwrap_or_else(|_|crate::config::to_ascii_domain(v.as_str().unwrap())))
                    .collect::<Vec<_>>())
            } else {
                json!(values)
            },
        );
    }
    Value::Object(o)
}
pub fn xray(v: &Value) -> Value {
    if v["op"] == "all" {
        let mut o = Map::new();
        for c in v["children"].as_array().unwrap() {
            o.extend(xray(c).as_object().unwrap().clone())
        }
        return Value::Object(o);
    }
    let field = v["field"].as_str().unwrap();
    let values: Vec<_> = v["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let key = xray_key(field).unwrap();
    let mut o = Map::new();
    let val = match field {
        "domain" | "domain_suffix" | "domain_keyword" | "domain_regex" => json!(values
            .iter()
            .map(|s| match field {
                "domain" => format!("full:{}", super::domains::normalize(s,false).unwrap_or_else(|_|s.to_string())),
                "domain_suffix" => format!("domain:{}", super::domains::normalize(s,true).unwrap_or_else(|_|s.to_string())),
                "domain_regex" => format!("regexp:{s}"),
                _ => s.to_string(),
            })
            .collect::<Vec<_>>()),
        "port" | "source_port" | "network" => json!(values.join(",").replace(':', "-")),
        _ => json!(values),
    };
    o.insert(key.into(), val);
    Value::Object(o)
}
pub fn mihomo(v: &Value) -> String {
    if let Some(op) = v["op"].as_str() {
        let parts: Vec<_> = v["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| format!("({})", mihomo(v)))
            .collect();
        return format!(
            "{},({})",
            match op {
                "any" => "OR",
                "not" => "NOT",
                _ => "AND",
            },
            parts.join(",")
        );
    }
    let field = v["field"].as_str().unwrap();
    let values = v["values"].as_array().unwrap();
    let parts: Vec<_> = values
        .iter()
        .map(|s| {
            let s = s.as_str().unwrap();
            let key = match field {
                "domain" => "DOMAIN",
                "domain_suffix" => "DOMAIN-SUFFIX",
                "domain_keyword" => "DOMAIN-KEYWORD",
                "domain_regex" => "DOMAIN-REGEX",
                "ip_cidr" => {
                    if s.contains(':') {
                        "IP-CIDR6"
                    } else {
                        "IP-CIDR"
                    }
                }
                "source_ip_cidr" => "SRC-IP-CIDR",
                "process_name" => "PROCESS-NAME",
                "process_path" => "PROCESS-PATH",
                "port" => "DST-PORT",
                "source_port" => "SRC-PORT",
                "inbound" => "IN-NAME",
                _ => "NETWORK",
            };
            let val = if matches!(field, "domain" | "domain_suffix") {
                super::domains::normalize(s,field=="domain_suffix").unwrap_or_else(|_|s.to_string())
            } else {
                s.to_string()
            };
            format!("{key},{val}")
        })
        .collect();
    if parts.len() == 1 {
        parts[0].clone()
    } else {
        format!(
            "OR,({})",
            parts
                .iter()
                .map(|s| format!("({s})"))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}
