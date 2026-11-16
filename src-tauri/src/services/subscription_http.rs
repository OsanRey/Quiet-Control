//! Subscription negotiation. No store, runtime or OS mutation is allowed here.
//! Errors/diagnostics intentionally never include response text or request URLs.
use crate::core::CoreKind;
use crate::domain::{ParseResult, SubscriptionClient as Client, SubscriptionHttp};
use crate::subscription::parse_subscription;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const BUDGET: Duration = Duration::from_secs(35);

#[derive(Debug, Clone, Default, Serialize)]
pub struct CheckReport {
    pub usable: bool,
    pub attempts: Vec<Attempt>,
    pub successful_client: Option<Client>,
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    pub client: Client,
    pub http_status: Option<u16>,
    pub format: Option<String>,
    pub recognized: usize,
    pub accepted: usize,
    pub excluded: usize,
    pub skipped: usize,
    pub device: Option<DeviceSignals>,
    /// Fixed machine code, never provider-controlled strings.
    pub result: String,
    pub supported: [usize; 3], // sing-box, Xray, Mihomo
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceSignals {
    pub id_sent: bool,
    pub active: bool,
    pub not_supported: bool,
    pub max_devices_reached: bool,
    pub legacy_limit: bool,
}

impl DeviceSignals {
    fn from_headers(headers: &reqwest::header::HeaderMap, id_sent: bool) -> Self {
        let flag = |name| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
        };
        Self {
            id_sent,
            active: flag("x-hwid-active"),
            not_supported: flag("x-hwid-not-supported"),
            max_devices_reached: flag("x-hwid-max-devices-reached"),
            legacy_limit: flag("x-hwid-limit"),
        }
    }
    fn rejection(&self) -> Option<&'static str> {
        // A real provider returns legacy_limit=true for missing HWID as well.
        // Prefer the specific cause; do not equate the legacy flag with a full account.
        if self.max_devices_reached {
            Some("device_limit")
        } else if self.not_supported {
            Some("device_required")
        } else if self.legacy_limit {
            Some("device_limit")
        } else {
            None
        }
    }
}

pub struct Fetched {
    pub body: String,
    pub headers: reqwest::header::HeaderMap,
    pub parsed: ParseResult,
    pub client: Client,
    pub remark_traffic: Option<crate::domain::SubscriptionTraffic>,
}

pub fn headers_for(mode: Client, custom: Option<&str>) -> (&str, &str) {
    match mode {
        Client::Auto => ("satelite-proxy/0.1 clash-verge/v2.5 flclash/1", "*/*"),
        // Family negotiation tokens, not claims to implement these applications.
        Client::Happ => ("Happ/3.3.6", "*/*"),
        Client::V2rayTun => ("v2RayTun", "*/*"),
        Client::Mihomo => ("mihomo/1.19.30", "*/*"),
        Client::Singbox => ("sing-box/1.13.18", "*/*"),
        Client::Custom => (custom.unwrap_or(""), "*/*"),
    }
}

type Cooldowns = HashMap<[u8; 32], SystemTime>;
fn cooldowns() -> &'static Mutex<Cooldowns> {
    static LIMITS: OnceLock<Mutex<Cooldowns>> = OnceLock::new();
    LIMITS.get_or_init(Default::default)
}

fn code_attempt(client: Client, code: &str) -> Attempt {
    Attempt {
        client,
        http_status: None,
        format: None,
        recognized: 0,
        accepted: 0,
        excluded: 0,
        skipped: 0,
        device: None,
        result: code.into(),
        supported: [0; 3],
    }
}

pub fn validate_options(http: &SubscriptionHttp, custom: Option<&str>) -> Result<(), &'static str> {
    let effective = if http.client == Client::Auto && custom.is_some_and(|s| !s.trim().is_empty()) {
        Client::Custom
    } else {
        http.client
    };
    let (ua, _) = headers_for(effective, custom);
    if ua.is_empty() || ua.len() > 512 || reqwest::header::HeaderValue::from_str(ua).is_err() {
        return Err("invalid_user_agent");
    }
    if let Some(accept) = &http.accept {
        if accept.is_empty()
            || accept.len() > 256
            || reqwest::header::HeaderValue::from_str(accept).is_err()
        {
            return Err("invalid_accept");
        }
    }
    if http.send_device_id {
        let valid = http.device_id.as_deref().is_some_and(|id| {
            id.len() == 36
                && id.bytes().enumerate().all(|(i, b)| {
                    if matches!(i, 8 | 13 | 18 | 23) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                })
        });
        if !valid {
            return Err("invalid_local_device_id");
        }
    }
    Ok(())
}

fn notice(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "клиент не поддерж",
        "используйте другое приложение",
        "используйте happ",
        "используйте v2ray",
        "unsupported client",
        "client not supported",
        "use happ",
        "use v2raytun",
        "обновите приложение",
    ]
    .iter()
    .any(|s| lower.contains(s))
}

/// Definitively unusable endpoints may accompany usable subscription nodes.
/// Never reject an ordinary node just because its display name is informational.
fn unusable_endpoint(node: &crate::domain::ProxyNode) -> bool {
    let host = node.server.trim();
    let ip_host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    host.is_empty()
        || (node.port == 0 && node.protocol != crate::domain::Protocol::Tor)
        || host == "0.0.0.1"
        || ip_host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_unspecified() || ip.is_multicast())
}

fn exclude_unusable(parsed: &mut ParseResult) -> usize {
    let before = parsed.nodes.len();
    parsed.nodes.retain(|node| !unusable_endpoint(node));
    let excluded = before - parsed.nodes.len();
    for _ in 0..excluded {
        parsed.skipped.push(crate::domain::SkippedProxy {
            name: None,
            reason: "subscription.unusable_endpoint".into(),
        });
    }
    excluded
}

/// Conservative quality gate. Names alone are never grounds to reject nodes.
pub fn quality(body: &str, content_type: &str, parsed: &ParseResult) -> &'static str {
    let head = body.trim_start().get(..body.trim_start().len().min(256));
    if content_type.to_ascii_lowercase().contains("text/html")
        || head.is_some_and(|h| {
            h.to_ascii_lowercase().contains("<html")
                || h.to_ascii_lowercase().starts_with("<!doctype html")
        })
    {
        return "html";
    }
    if parsed.nodes.is_empty() {
        return "empty";
    }
    let mut bad = 0;
    let mut placeholder = false;
    for node in &parsed.nodes {
        let host = node.server.trim();
        let invalid = unusable_endpoint(node)
            || (host.parse::<std::net::IpAddr>().is_err() && url::Host::parse(host).is_err());
        if invalid {
            bad += 1;
            placeholder |= notice(&node.name) || notice(body);
        }
    }
    if bad > 0 {
        return if placeholder {
            "placeholder"
        } else {
            "suspicious_endpoint"
        };
    }
    if parsed.nodes.iter().all(|node| {
        ![CoreKind::SingBox, CoreKind::Xray, CoreKind::Mihomo]
            .iter()
            .any(|core| core.supports_node(node))
    }) {
        return "unsupported_nodes";
    }
    "usable"
}

fn request_modes(http: &SubscriptionHttp, custom: Option<&str>) -> Vec<Client> {
    // Preserve legacy explicit Custom UA; never silently replace it with Auto.
    if http.client == Client::Auto && custom.is_some_and(|s| !s.trim().is_empty()) {
        return vec![Client::Custom];
    }
    if http.client != Client::Auto {
        return vec![http.client];
    }
    let mut modes = vec![Client::Auto];
    if let Some(last) = http
        .last_success
        .filter(|m| !matches!(m, Client::Auto | Client::Custom))
    {
        modes.push(last);
    }
    for mode in [
        Client::Happ,
        Client::V2rayTun,
        Client::Mihomo,
        Client::Singbox,
    ] {
        if !modes.contains(&mode) {
            modes.push(mode);
        }
    }
    modes
}

pub async fn fetch(
    url: &str,
    via_proxy: bool,
    port: Option<u16>,
    custom: Option<&str>,
    http: &SubscriptionHttp,
) -> (CheckReport, Option<Fetched>) {
    let mut report = CheckReport::default();
    if let Err(code) = validate_options(http, custom) {
        report.attempts.push(code_attempt(http.client, code));
        return (report, None);
    }
    let Ok(original) = url::Url::parse(url.trim()) else {
        report
            .attempts
            .push(code_attempt(http.client, "invalid_url"));
        return (report, None);
    };
    if !matches!(original.scheme(), "http" | "https") || original.host_str().is_none() {
        report
            .attempts
            .push(code_attempt(http.client, "invalid_url"));
        return (report, None);
    }
    let key: [u8; 32] = Sha256::digest(original.as_str().as_bytes()).into();
    {
        let now = SystemTime::now();
        let mut limits = cooldowns().lock().unwrap_or_else(|p| p.into_inner());
        limits.retain(|_, until| *until > now);
        if let Some(until) = limits.get(&key) {
            report.retry_after_seconds =
                Some(until.duration_since(now).unwrap_or_default().as_secs() + 1);
            report
                .attempts
                .push(code_attempt(http.client, "retry_after"));
            return (report, None);
        }
    }
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());
    if via_proxy {
        let proxy =
            reqwest::Proxy::all(format!("http://127.0.0.1:{}", port.unwrap_or(2080))).unwrap();
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }
    let Ok(client) = builder.build() else {
        report
            .attempts
            .push(code_attempt(http.client, "http_client"));
        return (report, None);
    };
    let deadline = tokio::time::Instant::now() + BUDGET;
    for mode in request_modes(http, custom) {
        let mut attempt = code_attempt(mode, "network_error");
        let operation = async {
            let (ua, accept) = headers_for(mode, custom);
            let mut target = original.clone();
            for redirect in 0..=3 {
                let mut request = client
                    .get(target.clone())
                    .header(reqwest::header::USER_AGENT, ua)
                    .header(
                        reqwest::header::ACCEPT,
                        http.accept.as_deref().unwrap_or(accept),
                    );
                if http.send_device_id {
                    request = request.header("x-hwid", http.device_id.as_deref().unwrap());
                }
                let response = request.send().await.map_err(|_| "network_error")?;
                attempt.http_status = Some(response.status().as_u16());
                if let Some(delay) = retry_delay(response.headers()) {
                    let now = SystemTime::now();
                    let mut limits = cooldowns().lock().unwrap_or_else(|p| p.into_inner());
                    // Never evict an unexpired embargo to make room for new requests.
                    if limits.len() < 256 || limits.contains_key(&key) {
                        limits.insert(
                            key,
                            now.checked_add(Duration::from_secs(delay)).unwrap_or(now),
                        );
                    }
                    report.retry_after_seconds = Some(delay);
                    return Err("retry_after");
                }
                let device = DeviceSignals::from_headers(response.headers(), http.send_device_id);
                let rejection = device.rejection();
                attempt.device = Some(device);
                if let Some(code) = rejection {
                    return Err(code);
                }
                if response.status().is_redirection() {
                    if redirect == 3 {
                        return Err("redirect_limit");
                    }
                    let next = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|h| h.to_str().ok())
                        .and_then(|location| target.join(location).ok())
                        .ok_or("invalid_redirect")?;
                    if !matches!(next.scheme(), "http" | "https")
                        || (target.scheme() == "https" && next.scheme() != "https")
                    {
                        return Err("unsafe_redirect");
                    }
                    if http.send_device_id && next.origin() != original.origin() {
                        return Err("device_cross_origin_redirect");
                    }
                    target = next;
                    continue;
                }
                if !response.status().is_success() {
                    return Err(match response.status().as_u16() {
                        401 | 403 => "permission_denied",
                        429 | 503 => "server_busy",
                        _ => "http_error",
                    });
                }
                let headers = response.headers().clone();
                let bytes = crate::services::http_body::read_limited(
                    response,
                    MAX_BYTES,
                    "body_limit".into(),
                )
                .await
                .map_err(|_| "body_error")?;
                let body = String::from_utf8(bytes).map_err(|_| "invalid_encoding")?;
                let lower = body.to_lowercase();
                if !http.send_device_id
                    && lower.contains("hwid")
                    && ["required", "missing", "требуется", "не передан"]
                        .iter()
                        .any(|s| lower.contains(s))
                {
                    return Err("device_required");
                }
                let mut parsed = parse_subscription(&body).map_err(|_| {
                    let lower = body.trim_start().to_ascii_lowercase();
                    if lower.starts_with("<") {
                        "html"
                    } else if notice(&body) {
                        "placeholder"
                    } else {
                        "invalid_format"
                    }
                })?;
                attempt.format = Some(crate::services::import::format_label(parsed.format));
                attempt.recognized = parsed.nodes.len();
                let remark_traffic = crate::services::import::traffic_from_remarks(&parsed.nodes);
                let content_type = headers
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("");
                let original_quality = quality(&body, content_type, &parsed);
                attempt.excluded = exclude_unusable(&mut parsed);
                attempt.skipped = parsed.skipped.len();
                if parsed.nodes.is_empty() {
                    return Err(original_quality);
                }
                let result = quality(&body, content_type, &parsed);
                for (i, core) in [CoreKind::SingBox, CoreKind::Xray, CoreKind::Mihomo]
                    .iter()
                    .enumerate()
                {
                    attempt.supported[i] = parsed
                        .nodes
                        .iter()
                        .filter(|n| core.supports_node(n))
                        .count();
                }
                if result != "usable" {
                    return Err(result);
                }
                attempt.accepted = parsed.nodes.len();
                return Ok(Fetched {
                    body,
                    headers,
                    parsed,
                    client: mode,
                    remark_traffic,
                });
            }
            Err("redirect_limit")
        };
        match tokio::time::timeout_at(deadline, operation).await {
            Ok(Ok(fetched)) => {
                attempt.result = if attempt.excluded > 0 {
                    "usable_with_exclusions"
                } else {
                    "usable"
                }
                .into();
                report.attempts.push(attempt);
                report.usable = true;
                report.successful_client = Some(mode);
                return (report, Some(fetched));
            }
            result => {
                let code = match result {
                    Ok(Err(code)) => code,
                    _ => "time_budget",
                };
                attempt.result = code.into();
                report.attempts.push(attempt);
                // Fallback negotiates formats only; transport/authentication failures are terminal.
                if !matches!(
                    code,
                    "html"
                        | "placeholder"
                        | "suspicious_endpoint"
                        | "invalid_format"
                        | "empty"
                        | "unsupported_nodes"
                ) {
                    break;
                }
            }
        }
    }
    (report, None)
}

fn retry_delay(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = raw.trim().parse::<u64>() {
        return Some(seconds.max(1));
    }
    // RFC 9110 IMF-fixdate. chrono is already in the pinned dependency graph.
    let date = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some((date.timestamp() - chrono::Utc::now().timestamp()).max(1) as u64)
}

pub fn safe_error(report: &CheckReport) -> String {
    // Deliberately serialize only our fixed report schema, never a reqwest/parser error.
    format!(
        "subscription.check_failed {}",
        serde_json::to_string(report).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{ProtocolConfig, SubscriptionSource},
        services::import::import_url_with_options,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread,
    };
    const UUID: &str = "11111111-2222-4333-8444-555555555555";
    #[tokio::test]
    #[ignore = "Opt-in offline fixture pipeline; no real subscription requests or persistence"]
    async fn offline_supplied_body_import_counts_only() {
        let path = std::env::var("QC_OFFLINE_SUBSCRIPTION_FILE").expect("Set opt-in path");
        let body = std::fs::read_to_string(path).expect("Read supplied copy");
        let server = Server::new(move |_| (200, String::new(), body.clone()));
        let result = import_url_with_options(
            None,
            server.url.clone(),
            None,
            false,
            None,
            None,
            Default::default(),
        )
        .await;
        match result {
            Ok(outcome) => {
                let mut reasons = std::collections::BTreeMap::new();
                for entry in &outcome.skipped {
                    *reasons.entry(entry.reason.as_str()).or_insert(0usize) += 1;
                }
                let mut protocols = std::collections::BTreeMap::new();
                for node in &outcome.nodes {
                    *protocols.entry(node.protocol.as_str()).or_insert(0usize) += 1;
                }
                println!(
                    "offline_import: {}",
                    serde_json::json!({"accepted":outcome.nodes.len(),"skipped":outcome.skipped.len(),"protocols":protocols,"reasons":reasons})
                );
            }
            Err(_) => println!("offline_import: rejected, cache would remain unchanged"),
        }
    }
    #[tokio::test]
    async fn excluded_quota_node_preserves_subscription_metadata() {
        let quota = good()
            .replace("vpn.example", "0.0.0.0")
            .replace("fixture", &urlencoding::encode("剩余流量：2.41 TB"));
        let server = Server::new(move |_| (200, String::new(), format!("{}\n{quota}", good())));
        let imported = import_url_with_options(
            None,
            server.url.clone(),
            None,
            false,
            None,
            None,
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(imported.nodes.len(), 1);
        assert!(
            imported
                .subscription
                .traffic
                .as_ref()
                .unwrap()
                .quota_remaining
                .unwrap()
                > 0
        );
    }
    #[tokio::test]
    async fn mixed_subscription_excludes_only_definitively_unusable_endpoints() {
        let server = Server::new(|_| {
            (
                200,
                "".into(),
                format!(
                    "{}\n{}\n{}\n{}",
                    good(),
                    good().replace("vpn.example", "0.0.0.0"),
                    good().replace("vpn.example", "[::]"),
                    stub()
                ),
            )
        });
        let (report, fetched) = probe(&server, &Default::default()).await;
        assert!(report.usable);
        assert_eq!(report.attempts.len(), 1);
        let attempt = &report.attempts[0];
        assert_eq!(attempt.result, "usable_with_exclusions");
        assert_eq!(
            (
                attempt.recognized,
                attempt.accepted,
                attempt.excluded,
                attempt.skipped
            ),
            (4, 1, 3, 3)
        );
        assert_eq!(attempt.supported, [1, 1, 1]);
        let fetched = fetched.unwrap();
        assert_payload(&fetched.parsed);
        assert_eq!(fetched.parsed.nodes.len(), 1);
        assert!(fetched.parsed.skipped.iter().all(|s| s.name.is_none()));
    }
    #[tokio::test]
    async fn provider_missing_id_precedes_ambiguous_legacy_limit() {
        let server = Server::new(|_| {
            (
                200,
                "x-hwid-active: true\r\nx-hwid-not-supported: true\r\nx-hwid-limit: true\r\n"
                    .into(),
                stub(),
            )
        });
        let (report, fetched) = probe(&server, &Default::default()).await;
        assert!(fetched.is_none());
        assert_eq!(report.attempts.len(), 1);
        let attempt = &report.attempts[0];
        assert_eq!(attempt.result, "device_required");
        let signals = attempt.device.as_ref().unwrap();
        assert!(!signals.id_sent);
        assert!(signals.not_supported && signals.legacy_limit && !signals.max_devices_reached);
        assert!(!safe_error(&report).contains("private-token"));
    }
    #[test]
    fn definite_device_limit_still_refuses_and_uncertain_hosts_are_not_removed() {
        let signals = DeviceSignals {
            active: true,
            id_sent: false,
            not_supported: true,
            max_devices_reached: true,
            legacy_limit: true,
        };
        assert_eq!(signals.rejection(), Some("device_limit"));
        let mut parsed = parse_subscription(&good()).unwrap();
        parsed.nodes[0].server = "bad host".into();
        assert_eq!(exclude_unusable(&mut parsed), 0);
        assert_eq!(quality("", "", &parsed), "suspicious_endpoint");
    }
    #[test]
    fn existing_tor_endpoint_has_no_remote_port() {
        let parsed = parse_subscription(
            r#"{"outbounds":[{"type":"tor","tag":"Tor","executable_path":"tor"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.nodes[0].port, 0);
        assert_eq!(quality("", "application/json", &parsed), "usable");
    }
    fn good() -> String {
        format!("vless://{UUID}@vpn.example:443?security=tls&sni=sni.example&type=ws&host=cdn.example&path=%2Fsocket#fixture")
    }
    fn stub() -> String {
        format!("vless://{UUID}@0.0.0.1:443#Use%20Happ%20unsupported%20client")
    }
    struct Server {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }
    impl Server {
        fn new(handler: impl Fn(&str) -> (u16, String, String) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let worker = thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Windows accepted sockets inherit the listener's nonblocking
                            // mode. Read the complete request before choosing a format.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut bytes = Vec::new();
                            let mut block = [0; 1024];
                            while bytes.len() < 16384 {
                                match stream.read(&mut block) {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => bytes.extend_from_slice(&block[..n]),
                                };
                                if bytes.ends_with(b"\r\n\r\n") {
                                    break;
                                }
                            }
                            let request = String::from_utf8_lossy(&bytes).to_string();
                            seen.lock().unwrap().push(request.clone());
                            let (status, headers, body) = handler(&request);
                            let response=format!("HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",body.len());
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                url: format!("http://{addr}/private-token"),
                requests,
                stop,
                worker: Some(worker),
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    async fn probe(server: &Server, http: &SubscriptionHttp) -> (CheckReport, Option<Fetched>) {
        fetch(&server.url, false, None, None, http).await
    }
    fn assert_payload(parsed: &ParseResult) {
        let n = &parsed.nodes[0];
        assert_eq!(n.server, "vpn.example");
        assert_eq!(n.port, 443);
        assert!(matches!(&n.config,ProtocolConfig::Vless{uuid,..} if uuid==UUID));
        assert_eq!(
            n.tls.as_ref().unwrap().server_name.as_deref(),
            Some("sni.example")
        );
        assert!(
            matches!(&n.transport,Some(crate::domain::Transport::Ws{path,headers,..}) if path.as_deref()==Some("/socket") && headers.as_ref().unwrap().get("Host").map(String::as_str)==Some("cdn.example"))
        );
        for core in [CoreKind::SingBox, CoreKind::Xray, CoreKind::Mihomo] {
            assert!(core.supports_node(n));
        }
        let mut store = crate::storage::AppStore::default();
        store.settings.current_node_id = Some(n.id.clone());
        let opts = crate::runtime::build_options(&store, String::new());
        for json in [
            serde_json::to_string(
                &crate::config::build_singbox_config(&parsed.nodes, &opts)
                    .unwrap()
                    .value,
            )
            .unwrap(),
            serde_json::to_string(
                &crate::config::build_xray_config(&parsed.nodes, &opts)
                    .unwrap()
                    .value,
            )
            .unwrap(),
            crate::config::build_mihomo_config(&parsed.nodes, &opts)
                .unwrap()
                .yaml,
        ] {
            for expected in [UUID, "vpn.example", "sni.example", "cdn.example", "/socket"] {
                assert!(json.contains(expected), "missing {expected}");
            }
        }
    }
    #[tokio::test]
    async fn ordinary_payload_and_content_are_preserved() {
        let server = Server::new(|_| (200, "".into(), good()));
        let (report, result) = probe(&server, &Default::default()).await;
        assert!(report.usable);
        assert_eq!(report.attempts.len(), 1);
        assert_payload(&result.unwrap().parsed);
        assert!(!server.requests.lock().unwrap()[0]
            .to_lowercase()
            .contains("x-hwid"));
    }
    #[tokio::test]
    async fn auto_rejects_stub_and_negotiates_happ() {
        let server = Server::new(|r| {
            (
                200,
                "".into(),
                if r.contains("Happ/") { good() } else { stub() },
            )
        });
        let (report, result) = probe(&server, &Default::default()).await;
        assert_eq!(report.attempts[0].result, "placeholder");
        assert_eq!(report.successful_client, Some(Client::Happ));
        assert_payload(&result.unwrap().parsed);
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        let mut http = SubscriptionHttp::default();
        http.last_success = Some(Client::Mihomo);
        assert_eq!(
            request_modes(&http, None),
            vec![
                Client::Auto,
                Client::Mihomo,
                Client::Happ,
                Client::V2rayTun,
                Client::Singbox
            ]
        );
    }
    #[tokio::test]
    async fn explicit_modes_do_not_fallback_and_reports_contain_no_secrets() {
        let server = Server::new(|_| (200, "".into(), stub()));
        let http = SubscriptionHttp {
            client: Client::Singbox,
            ..Default::default()
        };
        let (report, result) = probe(&server, &http).await;
        assert!(result.is_none());
        assert_eq!(report.attempts.len(), 1);
        let diagnostic = safe_error(&report);
        for secret in [UUID, "private-token", "vless://", "0.0.0.1"] {
            assert!(!diagnostic.contains(secret));
        }
    }
    #[tokio::test]
    async fn every_allowed_mode_fails_with_bounded_requests() {
        let server = Server::new(|_| {
            (
                200,
                "Content-Type: text/html\r\n".into(),
                "<html>not a subscription</html>".into(),
            )
        });
        let (report, result) = probe(&server, &Default::default()).await;
        assert!(result.is_none());
        assert_eq!(report.attempts.len(), 5);
        assert_eq!(server.requests.lock().unwrap().len(), 5);
    }
    #[tokio::test]
    async fn permission_denial_and_device_limit_are_terminal() {
        for (status, header, code) in [
            (403, "", "permission_denied"),
            (200, "x-hwid-max-devices-reached: true\r\n", "device_limit"),
        ] {
            let server = Server::new(move |_| (status, header.into(), stub()));
            let (r, f) = probe(&server, &Default::default()).await;
            assert!(f.is_none());
            assert_eq!(r.attempts.len(), 1);
            assert_eq!(r.attempts[0].result, code);
        }
    }
    #[tokio::test]
    async fn random_local_device_id_is_explicit_stable_and_persisted() {
        let server = Server::new(|r| {
            if r.to_lowercase().contains("x-hwid:") {
                (200, "".into(), good())
            } else {
                (200, "x-hwid-not-supported: true\r\n".into(), stub())
            }
        });
        let (r, f) = probe(&server, &Default::default()).await;
        assert!(f.is_none());
        assert_eq!(r.attempts[0].result, "device_required");
        let http = SubscriptionHttp {
            client: Client::Happ,
            send_device_id: true,
            device_id: Some("abcdefab-1234-4567-89ab-abcdefabcdef".into()),
            ..Default::default()
        };
        let restored: SubscriptionHttp =
            serde_json::from_str(&serde_json::to_string(&http).unwrap()).unwrap();
        assert_eq!(http, restored);
        for _ in 0..2 {
            assert!(probe(&server, &restored).await.0.usable);
        }
        let requests = server.requests.lock().unwrap();
        for r in &requests[1..] {
            assert!(r.contains("abcdefab-1234-4567-89ab-abcdefabcdef"));
            assert!(!r.contains("x-device"));
        }
    }
    #[tokio::test]
    async fn full_store_reload_preserves_per_subscription_http_options() {
        let server = Server::new(|_| (200, "".into(), good()));
        let http = SubscriptionHttp {
            client: Client::Happ,
            send_device_id: true,
            device_id: Some("abcdefab-1234-4567-89ab-abcdefabcdef".into()),
            accept: Some("text/plain".into()),
            ..Default::default()
        };
        let imported = import_url_with_options(
            None,
            server.url.clone(),
            Some("stable-id".into()),
            false,
            None,
            None,
            http.clone(),
        )
        .await
        .unwrap();
        let mut store = crate::storage::AppStore::default();
        store
            .upsert_subscription(imported.subscription, imported.nodes)
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "qc-subscription-persistence-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("store.json");
        store.save(&path).unwrap();
        let reloaded = crate::storage::AppStore::load(&path, None).unwrap();
        let saved = &reloaded
            .subscriptions
            .iter()
            .find(|s| s.id == "stable-id")
            .unwrap()
            .http;
        assert_eq!(saved.client, http.client);
        assert_eq!(saved.accept, http.accept);
        assert_eq!(saved.device_id, http.device_id);
        assert!(saved.send_device_id);
        assert_eq!(saved.last_success, Some(Client::Happ));
        // Remove only files produced in this uniquely-created fixture directory.
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                std::fs::remove_file(entry.path()).unwrap();
            }
        }
        std::fs::remove_dir(&dir).unwrap();
    }
    #[tokio::test]
    async fn device_id_is_not_forwarded_to_another_origin() {
        let target = Server::new(|_| (200, "".into(), good()));
        let target_url = target.url.clone();
        let source =
            Server::new(move |_| (302, format!("Location: {target_url}\r\n"), String::new()));
        let options = SubscriptionHttp {
            client: Client::Happ,
            send_device_id: true,
            device_id: Some("abcdefab-1234-4567-89ab-abcdefabcdef".into()),
            ..Default::default()
        };
        let (report, result) = probe(&source, &options).await;
        assert!(result.is_none());
        assert_eq!(report.attempts[0].result, "device_cross_origin_redirect");
        assert!(target.requests.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn retry_after_stops_requests_and_embargoes_same_url() {
        for header in [
            "Retry-After: 120\r\n",
            "Retry-After: Wed, 01 Jan 2031 00:00:00 GMT\r\n",
        ] {
            let server = Server::new(move |_| (429, header.into(), "limit".into()));
            let (r, _) = probe(&server, &Default::default()).await;
            assert!(r.retry_after_seconds.unwrap() > 1);
            let (r, _) = probe(&server, &Default::default()).await;
            assert_eq!(r.attempts[0].result, "retry_after");
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }
    #[tokio::test]
    async fn invalid_refresh_preserves_cached_store_and_selection() {
        let server = Server::new(|r| {
            (
                200,
                "".into(),
                if r.contains("Custom-Good") {
                    good()
                } else {
                    stub()
                },
            )
        });
        let imported = import_url_with_options(
            Some("fixture".into()),
            server.url.clone(),
            Some("stable-id".into()),
            false,
            None,
            Some("Custom-Good".into()),
            Default::default(),
        )
        .await
        .unwrap();
        let mut store = crate::storage::AppStore::default();
        let id = imported.nodes[0].id.clone();
        store
            .upsert_subscription(imported.subscription, imported.nodes)
            .unwrap();
        store.favorite_nodes.insert(id.clone());
        store.settings.current_node_id = Some(id);
        let before = serde_json::to_value(&store).unwrap();
        let failed = import_url_with_options(
            None,
            server.url.clone(),
            Some("stable-id".into()),
            false,
            None,
            None,
            Default::default(),
        )
        .await;
        assert!(failed.is_err());
        assert_eq!(before, serde_json::to_value(&store).unwrap());
        // Read-only preview also has no store/runtime handle and cannot commit.
        assert!(!probe(&server, &Default::default()).await.0.usable);
        assert_eq!(before, serde_json::to_value(&store).unwrap());
        assert!(matches!(
            store.subscriptions[0].source,
            SubscriptionSource::Url { .. }
        ));
    }
    #[test]
    fn suspicious_and_ordinary_names_are_distinguished() {
        let p = parse_subscription(&good().replace("fixture", "Unsupported%20client")).unwrap();
        assert_eq!(quality("", "", &p), "usable");
        let p = parse_subscription(&good().replace("vpn.example", "0.0.0.1")).unwrap();
        assert_eq!(quality("", "", &p), "suspicious_endpoint");
        assert!(validate_options(
            &SubscriptionHttp {
                client: Client::Custom,
                ..Default::default()
            },
            Some("secret\r\nInjected: yes")
        )
        .is_err());
        assert!(validate_options(
            &SubscriptionHttp {
                send_device_id: true,
                ..Default::default()
            },
            None
        )
        .is_err());
    }
    #[tokio::test]
    async fn accept_format_negotiation_and_xray_payload() {
        let server = Server::new(|r| {
            if r.contains("application/json") {
                (200,"Content-Type: application/json\r\n".into(),serde_json::json!([{"remarks":"fixture","outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"vpn.example","port":443,"users":[{"id":UUID,"encryption":"none"}]}]},"streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"sni.example"},"wsSettings":{"path":"/socket","headers":{"Host":"cdn.example"}}}},{"protocol":"freedom"}]}]).to_string())
            } else {
                (200, "".into(), good())
            }
        });
        let (r, f) = probe(
            &server,
            &SubscriptionHttp {
                client: Client::Happ,
                accept: Some("application/json".into()),
                ..Default::default()
            },
        )
        .await;
        assert!(r.usable, "{r:?}");
        assert_eq!(
            r.attempts[0].format.as_deref(),
            Some("xray_json"),
            "requests: {:?}",
            server.requests.lock().unwrap()
        );
        assert_payload(&f.unwrap().parsed);
    }
}
