//! Import independent Xray outbound endpoints, never provider routing/inbounds.
//! Chained/fragmented or unmodelled transports are rejected, not flattened.
use crate::domain::{ManualNodeDraft, ParseResult, SkippedProxy, SubscriptionFormat};
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};

pub fn looks_like_xray(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(looks_like_xray),
        Value::Object(_) => {
            value.get("protocol").is_some()
                || value
                    .get("outbounds")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().any(|v| v.get("protocol").is_some()))
        }
        _ => false,
    }
}

pub fn parse(value: &Value) -> AppResult<ParseResult> {
    let docs: Vec<&Value> = value
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_else(|| vec![value]);
    super::ensure_entry_limit(docs.len())?;
    let mut entries = Vec::new();
    let named_configs =
        matches!(value,Value::Array(items) if items.iter().all(|d|d.get("outbounds").is_some()));
    let mut document_skips = Vec::new();
    for (index, doc) in docs.into_iter().enumerate() {
        if let Some(outbounds) = doc.get("outbounds").and_then(Value::as_array) {
            super::ensure_entry_limit(outbounds.len())?;
            if named_configs {
                let name = Some(format!("Xray #{}", index + 1));
                if doc["routing"]["balancers"]
                    .as_array()
                    .is_some_and(|b| !b.is_empty())
                {
                    document_skips.push(SkippedProxy {
                        name,
                        reason: "xray_balancer_requires_custom_config".into(),
                    });
                    continue;
                }
                let proxies: Vec<_> = outbounds
                    .iter()
                    .filter(|o| {
                        !matches!(
                            o["protocol"].as_str(),
                            Some("freedom" | "blackhole" | "dns")
                        )
                    })
                    .collect();
                // A client-config array describes profiles, not a flat catalogue of
                // every fallback in every profile. Never multiply its node count.
                if proxies.len() == 1 {
                    entries.push((doc, proxies[0], index + 1));
                } else {
                    document_skips.push(SkippedProxy {
                        name,
                        reason: "xray_multiple_outbounds_require_custom_config".into(),
                    });
                }
                continue;
            }
            for outbound in outbounds {
                entries.push((doc, outbound, index + 1));
            }
        } else {
            entries.push((doc, doc, index + 1));
        }
        super::ensure_entry_limit(entries.len())?;
    }
    let mut nodes = Vec::new();
    let mut skipped = document_skips;
    for (doc, outbound, index) in entries {
        if matches!(
            outbound["protocol"].as_str(),
            Some("freedom" | "blackhole" | "dns")
        ) {
            continue;
        }
        match endpoint(doc, outbound) {
            Ok(node) => nodes.push(node),
            Err(reason) => skipped.push(SkippedProxy {
                name: Some(format!("Xray #{}", index)),
                reason: reason.into(),
            }),
        }
    }
    if nodes.is_empty() {
        return Err(AppError::NoProxies);
    }
    Ok(ParseResult {
        nodes,
        skipped,
        format: SubscriptionFormat::XrayJson,
    })
}

fn endpoint(doc: &Value, o: &Value) -> Result<crate::domain::ProxyNode, &'static str> {
    let protocol = o["protocol"].as_str().ok_or("missing_protocol")?;
    if !matches!(
        protocol,
        "vless" | "vmess" | "trojan" | "shadowsocks" | "socks" | "http" | "hysteria"
    ) {
        return Err("unsupported_xray_protocol");
    }
    let stream = &o["streamSettings"];
    if stream.get("finalmask").is_some_and(|m| {
        !m.is_null()
            && m.as_object().is_none_or(|m| {
                m.values().any(|v| {
                    !v.is_null()
                        && v.as_array().is_none_or(|a| !a.is_empty())
                        && v.as_object().is_none_or(|o| !o.is_empty())
                })
            })
    }) {
        return Err("xray_finalmask_requires_custom_config");
    }
    if protocol == "hysteria" {
        if o["settings"]["version"].as_u64() != Some(2)
            || stream["hysteriaSettings"]["version"].as_u64() != Some(2)
            || stream["network"].as_str() != Some("hysteria")
        {
            return Err("unsupported_xray_hysteria_version");
        }
        if stream.get("sockopt").is_some()
            || o.get("proxySettings").is_some()
            || o.get("sendThrough").is_some()
            || stream["security"].as_str() != Some("tls")
        {
            return Err("xray_chaining_or_socket_options_require_custom_config");
        }
        let settings = &o["settings"];
        let tls = &stream["tlsSettings"];
        if [
            "certificates",
            "pinnedPeerCertChainSha256",
            "verifyPeerCertInNames",
            "echConfigList",
            "disableSystemRoot",
        ]
        .iter()
        .any(|k| tls.get(k).is_some())
        {
            return Err("xray_custom_tls_verification_requires_custom_config");
        }
        let draft:ManualNodeDraft=serde_json::from_value(json!({"protocol":"hysteria2","server":settings["address"],"port":settings["port"],"name":doc["remarks"].as_str().or_else(||o["tag"].as_str()),"password":stream["hysteriaSettings"]["auth"],"tls":true,"sni":tls["serverName"],"insecure":tls["allowInsecure"],"alpn":tls["alpn"].as_array().map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","))})).map_err(|_|"invalid_xray_fields")?;
        return super::draft_to_node(&draft, None).map_err(|_| "invalid_xray_endpoint");
    }
    if o.get("proxySettings").is_some()
        || o.get("sendThrough").is_some()
        || stream.get("sockopt").is_some()
    {
        return Err("xray_chaining_or_socket_options_require_custom_config");
    }
    let servers = if matches!(protocol, "vless" | "vmess") {
        &o["settings"]["vnext"]
    } else {
        &o["settings"]["servers"]
    };
    let servers = servers.as_array().ok_or("missing_xray_server")?;
    if servers.len() != 1 {
        return Err("multiple_xray_servers_require_custom_config");
    }
    let server = &servers[0];
    let user = if matches!(protocol, "vless" | "vmess" | "socks" | "http") {
        match server["users"].as_array() {
            Some(users) if users.len() == 1 => &users[0],
            None if matches!(protocol, "socks" | "http") => &Value::Null,
            _ => return Err("unsupported_xray_users"),
        }
    } else {
        server
    };
    if protocol == "vless" && user["encryption"].as_str().is_some_and(|v| v != "none") {
        return Err("unsupported_xray_vless_encryption");
    }
    let network = stream["network"].as_str().unwrap_or("tcp");
    if !matches!(
        network,
        "tcp" | "raw" | "ws" | "grpc" | "http" | "h2" | "xhttp" | "splithttp"
    ) {
        return Err("unsupported_xray_transport");
    }
    if stream["tcpSettings"]
        .get("header")
        .is_some_and(|h| h["type"].as_str().is_some_and(|s| s != "none"))
    {
        return Err("unsupported_xray_tcp_header");
    }
    let security = stream["security"].as_str().unwrap_or("none");
    if !matches!(security, "none" | "tls" | "reality") {
        return Err("unsupported_xray_security");
    }
    let tls = if security == "reality" {
        &stream["realitySettings"]
    } else {
        &stream["tlsSettings"]
    };
    if [
        "certificates",
        "pinnedPeerCertChainSha256",
        "verifyPeerCertInNames",
        "echConfigList",
        "disableSystemRoot",
    ]
    .iter()
    .any(|key| tls.get(key).is_some())
    {
        return Err("xray_custom_tls_verification_requires_custom_config");
    }
    let transport = match network {
        "ws" => &stream["wsSettings"],
        "grpc" => &stream["grpcSettings"],
        "http" | "h2" => &stream["httpSettings"],
        "xhttp" | "splithttp" => stream
            .get("xhttpSettings")
            .or_else(|| stream.get("splithttpSettings"))
            .unwrap_or(&Value::Null),
        _ => &Value::Null,
    };
    if transport.get("earlyDataHeaderName").is_some() || transport.get("maxEarlyData").is_some() {
        return Err("unsupported_xray_early_data");
    }
    let host = transport["headers"]["Host"]
        .as_str()
        .map(str::to_string)
        .or_else(|| transport["headers"]["host"].as_str().map(str::to_string))
        .or_else(|| transport["host"].as_str().map(str::to_string))
        .or_else(|| {
            transport["host"].as_array().map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
        });
    let draft: ManualNodeDraft=serde_json::from_value(json!({
        "protocol":if protocol=="socks" {"socks5"} else {protocol},
        "server":server["address"],"port":server["port"],
        "name":doc["remarks"].as_str().or_else(||o["tag"].as_str()),
        "uuid":user["id"],"password":user["password"].as_str().or_else(||user["pass"].as_str()),
        "username":user["user"],"method":server["method"],"flow":user["flow"],
        "alterId":user["alterId"],"security":user["security"],
        "tls":security!="none", "sni":tls["serverName"],"insecure":tls["allowInsecure"],
        "alpn":tls["alpn"].as_array().map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")),
        "fingerprint":tls["fingerprint"],"realityPublicKey":tls["publicKey"],"realityShortId":tls["shortId"],
        "network":if network=="raw" {"tcp"} else {network},"path":transport["path"],"host":host,"serviceName":transport["serviceName"]
    })).map_err(|_|"invalid_xray_fields")?;
    let mut node = super::draft_to_node(&draft, None).map_err(|_| "invalid_xray_endpoint")?;
    if matches!(network, "xhttp" | "splithttp") {
        node.transport = Some(crate::domain::Transport::Xhttp {
            path: transport["path"].as_str().map(str::to_string),
            host: transport["host"].as_str().map(str::to_string),
            mode: transport["mode"].as_str().map(str::to_string),
            extra: transport.get("extra").map(Value::to_string),
        });
        node = node.with_computed_id();
    }
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vless() -> Value {
        json!({"protocol":"vless","tag":"proxy","settings":{"vnext":[{"address":"vpn.example","port":443,"users":[{"id":"11111111-2222-4333-8444-555555555555","encryption":"none"}]}]}})
    }
    #[test]
    fn client_config_array_is_not_a_flat_outbound_catalogue() {
        let good = json!({"remarks":"fixture","outbounds":[vless(),{"protocol":"freedom"},{"protocol":"blackhole"}]});
        let mut balanced = good.clone();
        balanced["routing"] = json!({"balancers":[{"tag":"balance","selector":["proxy"]}]});
        balanced["outbounds"]
            .as_array_mut()
            .unwrap()
            .extend([vless(), vless(), vless()]);
        let parsed = parse(&json!([good, balanced])).unwrap();
        assert_eq!(parsed.nodes.len(), 1);
        assert_eq!(parsed.skipped.len(), 1);
        assert_eq!(
            parsed.skipped[0].reason,
            "xray_balancer_requires_custom_config"
        );
        assert_eq!(parsed.skipped[0].name.as_deref(), Some("Xray #2"));
    }
    #[test]
    fn xhttp_preserves_mode_host_path_and_extra() {
        let mut node = vless();
        node["streamSettings"] = json!({"network":"xhttp","xhttpSettings":{"path":"/upload","host":"cdn.example","mode":"stream-up","extra":{"scMaxBufferedPosts":16}}});
        let n = endpoint(&Value::Null, &node).unwrap();
        assert!(
            matches!(&n.transport,Some(crate::domain::Transport::Xhttp{path,host,mode,extra}) if path.as_deref()==Some("/upload")&&host.as_deref()==Some("cdn.example")&&mode.as_deref()==Some("stream-up")&&extra.as_deref()==Some("{\"scMaxBufferedPosts\":16}"))
        );
        assert!(crate::core::CoreKind::Xray.supports_node(&n));
        node["streamSettings"]["finalmask"] = json!({"tcp":[{"type":"fragment"}]});
        assert_eq!(
            endpoint(&Value::Null, &node).unwrap_err(),
            "xray_finalmask_requires_custom_config"
        );
    }
    #[test]
    fn xray_hysteria_version_two_is_the_existing_hysteria2_model() {
        let node = json!({"protocol":"hysteria","settings":{"address":"hy.example","port":443,"version":2},"streamSettings":{"network":"hysteria","security":"tls","hysteriaSettings":{"auth":"fixture-password","version":2},"tlsSettings":{"serverName":"sni.example","alpn":["h3"]}}});
        let parsed = endpoint(&Value::Null, &node).unwrap();
        assert_eq!(parsed.protocol, crate::domain::Protocol::Hysteria2);
        assert!(
            matches!(parsed.config,crate::domain::ProtocolConfig::Hysteria2{ref password,..} if password=="fixture-password")
        );
        assert_eq!(
            parsed.tls.as_ref().unwrap().server_name.as_deref(),
            Some("sni.example")
        );
        for core in [
            crate::core::CoreKind::SingBox,
            crate::core::CoreKind::Xray,
            crate::core::CoreKind::Mihomo,
        ] {
            assert!(core.supports_node(&parsed));
        }
    }
    #[test]
    fn hysteria_uri_version_two_and_vless_encryption_are_not_silently_changed() {
        let parsed=crate::subscription::parse_subscription("hysteria://fixture-password@hy.example:443?version=2&security=tls&sni=sni.example&alpn=h3#Fixture").unwrap();
        assert_eq!(parsed.nodes[0].protocol, crate::domain::Protocol::Hysteria2);
        let mut encrypted = vless();
        encrypted["settings"]["vnext"][0]["users"][0]["encryption"] =
            json!("mlkem768x25519plus.fixture");
        assert_eq!(
            endpoint(&Value::Null, &encrypted).unwrap_err(),
            "unsupported_xray_vless_encryption"
        );
        assert!(crate::subscription::parse_subscription("vless://11111111-2222-4333-8444-555555555555@vpn.example:443?encryption=mlkem768x25519plus.fixture#Fixture").is_err());
    }
    #[test]
    #[ignore = "Offline opt-in audit; outputs counts only and never starts a core"]
    fn offline_supplied_subscription_counts_only() {
        let path = std::env::var("QC_OFFLINE_SUBSCRIPTION_FILE").expect("Set opt-in input path");
        let input = std::fs::read_to_string(path).expect("Read supplied local copy");
        let parsed = match crate::subscription::parse_subscription(&input) {
            Ok(parsed) => parsed,
            Err(_) => {
                println!("offline_audit: no importable independent nodes");
                return;
            }
        };
        let mut reasons = std::collections::BTreeMap::new();
        for entry in &parsed.skipped {
            *reasons.entry(entry.reason.as_str()).or_insert(0usize) += 1;
        }
        let mut protocols = std::collections::BTreeMap::new();
        for node in &parsed.nodes {
            *protocols.entry(node.protocol.as_str()).or_insert(0usize) += 1;
        }
        println!(
            "offline_audit: {}",
            serde_json::json!({"recognized":parsed.nodes.len(),"skipped":parsed.skipped.len(),"reasons":reasons,"protocols":protocols})
        );
    }
    #[test]
    fn ordinary_xray_endpoint() {
        let outbound = json!({"protocol":"vless","settings":{"vnext":[{"address":"vpn.example","port":443,"users":[{"id":"11111111-2222-4333-8444-555555555555","encryption":"none"}]}]},"streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"sni.example"},"wsSettings":{"path":"/socket","headers":{"Host":"cdn.example"}}}});
        let n = endpoint(&json!({"remarks":"fixture"}), &outbound).unwrap();
        assert_eq!(n.server, "vpn.example");
        let mut chained = outbound.clone();
        chained["proxySettings"] = json!({"tag":"relay"});
        assert!(endpoint(&Value::Null, &chained).is_err());
        let mut pinned = outbound.clone();
        pinned["streamSettings"]["tlsSettings"]["pinnedPeerCertChainSha256"] = json!(["hash"]);
        assert!(endpoint(&Value::Null, &pinned).is_err());
    }
}
