//! Explicit profile checks own a separate loopback-only core, never Runtime.
use crate::{api::ClashApi, config::{self, BuildOptions}, core::{self, manager::CoreManager, CoreKind},
    domain::{AutoSelectMode, OutboundMode, ProxyNode}, storage::AppStore};
use std::{net::TcpListener, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}};

static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub fn proxy_url_error(kind: CoreKind, url: &str) -> Option<&'static str> {
    // sing-box 1.13.18 discards HTTP delay URLs and tests its default HTTPS
    // endpoint instead. Do not attribute that unrelated failure to this node.
    (kind == CoreKind::SingBox && url.trim().to_ascii_lowercase().starts_with("http://"))
        .then_some("probe.singbox_https_only")
}
pub struct Flight;
impl Flight {
    pub fn acquire() -> Result<Self, String> {
        IN_FLIGHT.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| "A profile check is already running".into())
    }
}
impl Drop for Flight { fn drop(&mut self) { IN_FLIGHT.store(false, Ordering::Release); } }

pub struct ProbeCore { manager: CoreManager, dir: PathBuf, pub api: ClashApi, _flight: Flight }
impl Drop for ProbeCore {
    fn drop(&mut self) {
        self.api.deactivate();
        if self.manager.stop().is_ok() { let _ = std::fs::remove_dir_all(&self.dir); }
    }
}

fn options(mixed: u16, api: u16, secret: String) -> BuildOptions {
    // Never inherit TUN, proxy, rules, listeners, URLs, or autoselect from the
    // user's running profile. The existing generators still own node dialects.
    let mut opts = crate::runtime::build_options(&AppStore::default(), secret);
    opts.mixed_port = mixed; opts.api_port = api; opts.allow_lan = false;
    opts.extra_inbounds.clear(); opts.tun_enabled = false; opts.tun_ipv6 = false;
    opts.rules.clear(); opts.rule_sets.clear(); opts.pools.clear(); opts.chains.clear();
    opts.outbound_mode = OutboundMode::Global; opts.auto_select = AutoSelectMode::Off;
    opts.find_process = false; opts.block_quic = false; opts.bypass_lan = false;
    opts.dns.dns_final = "local".into();
    opts
}

pub fn unsupported_reason(kind:CoreKind,node:&ProxyNode)->Option<&'static str> {
    if matches!(node.protocol,crate::domain::Protocol::WireGuard|crate::domain::Protocol::Tor) {
        return Some("probe.stateful_protocol");
    }
    if kind==CoreKind::Xray {return Some("probe.xray_no_delay_api");}
    if !kind.supports_node(node) {return Some("probe.core_unsupported");}
    None
}

impl ProbeCore {
    pub fn start(root: &Path, resources: Option<&Path>, kind: CoreKind, nodes: &[ProxyNode]) -> Result<Self, String> {
        let flight = Flight::acquire()?;
        if kind == CoreKind::Xray { return Err("Xray has no through-proxy latency API; use TCP check".into()); }
        if nodes.is_empty() { return Err("No supported nodes to check".into()); }
        let (binary, _) = core::inspect_core_bin(root, resources, kind);
        let binary = binary.ok_or("The required core is not installed")?;
        let a = TcpListener::bind(("127.0.0.1", 0)).map_err(|e|e.to_string())?;
        let b = TcpListener::bind(("127.0.0.1", 0)).map_err(|e|e.to_string())?;
        let mixed = a.local_addr().map_err(|e|e.to_string())?.port();
        let port = b.local_addr().map_err(|e|e.to_string())?.port();
        let secret = config::generate_api_secret();
        let opts = options(mixed, port, secret.clone());
        let (name, content) = match kind {
            CoreKind::SingBox => ("active.json", serde_json::to_vec(&config::build_singbox_config(nodes, &opts).map_err(|e|e.to_string())?.value).map_err(|e|e.to_string())?),
            CoreKind::Mihomo => ("active.yaml", config::build_mihomo_config(nodes, &opts).map_err(|e|e.to_string())?.yaml.into_bytes()),
            CoreKind::Xray => unreachable!(),
        };
        let parent = root.join("data/profile-probes");
        std::fs::create_dir_all(&parent).map_err(|e|e.to_string())?;
        let dir = parent.join(config::generate_api_secret());
        std::fs::create_dir(&dir).map_err(|e|e.to_string())?;
        let mut own = Self {manager:CoreManager::default(), dir, api:ClashApi::new("127.0.0.1", port, &secret), _flight: flight};
        let config_dir = own.dir.join("config");
        std::fs::create_dir(&config_dir).map_err(|e|e.to_string())?;
        let path = config_dir.join(name);
        std::fs::write(&path, content).map_err(|e|e.to_string())?;
        drop(a); drop(b);
        own.manager.start_with_ports(kind, &binary, &path, &own.dir.join("logs"), mixed, Some(port), &[], false, resources)
            .map_err(|e|e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !own.api.health_ok() {
            own.manager.poll();
            if !own.manager.is_running() || std::time::Instant::now() >= deadline {
                return Err("The temporary profile-check API did not become ready".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Ok(own)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn http_delay_url_is_not_silently_replaced_for_singbox() {
        assert_eq!(proxy_url_error(CoreKind::SingBox,"http://example.test/health"),Some("probe.singbox_https_only"));
        assert!(proxy_url_error(CoreKind::SingBox,"https://example.test/health").is_none());
        assert!(proxy_url_error(CoreKind::Mihomo,"http://example.test/health").is_none());
    }
    #[test] fn isolated_options_do_not_capture_or_inherit_user_routes() {
        let o = options(32001, 32002, "test-secret".into());
        assert!(!o.tun_enabled && !o.allow_lan && !o.tun_ipv6 && !o.find_process);
        assert!(o.extra_inbounds.is_empty() && o.rules.is_empty() && o.rule_sets.is_empty() && o.chains.is_empty());
        assert_eq!(o.auto_select, AutoSelectMode::Off);
        assert_eq!(o.mixed_port, 32001);assert_eq!(o.api_port, 32002);
    }
    #[test] fn one_owned_probe_at_a_time_and_release_on_drop() {
        let first = Flight::acquire().unwrap();assert!(Flight::acquire().is_err());
        drop(first);assert!(Flight::acquire().is_ok());
    }
}
