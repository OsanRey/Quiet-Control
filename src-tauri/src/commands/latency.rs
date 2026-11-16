use crate::services::latency::{ping_nodes_streaming, probe_nodes_streaming, LatencyResult};
use crate::state::AppState;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Manager};

use super::config::custom_config_nodes;

#[derive(Debug, Serialize)]
pub struct LatencyBatchResult {
    pub results: Vec<LatencyResult>,
    pub tested: usize,
    pub ok: usize,
    pub failed: usize,
    /// `clash_api` or `tcp`
    pub method: String,
}

/// Forward one finished probe to the frontend over the invoke's IPC channel
/// so the UI can update that node immediately. A dead channel (webview
/// navigated away mid-run) is not an error — the batch return still carries
/// every result.
fn stream_result(channel: &Channel<LatencyResult>, r: &LatencyResult) {
    let _ = channel.send(r.clone());
}

/// Load the probe set preserving the caller's id order: the UI sends ids in
/// current display order, so probes launch — and stream back — top to
/// bottom instead of in store insertion order.
fn load_nodes_in_display_order(
    state: &State<'_, AppState>,
    ids: &Option<Vec<String>>,
) -> Result<Vec<crate::domain::ProxyNode>, String> {
    state
        .with_store(|store| {
            let all = store.enabled_nodes();
            Ok(match ids {
                Some(ids) => {
                    let by_id: std::collections::HashMap<&str, &crate::domain::ProxyNode> =
                        all.iter().map(|n| (n.id.as_str(), n)).collect();
                    ids.iter()
                        .filter_map(|id| by_id.get(id.as_str()).map(|n| (*n).clone()))
                        .collect()
                }
                None => all,
            })
        })
        .map_err(|e| e.to_string())
}

/// Test latency for each node: direct TCP connect for TCP-based protocols,
/// clash delay API for UDP-only protocols (hysteria/hysteria2/tuic) when the
/// core is running — a plain TCP connect to those ports always times out
/// regardless of node health, so it can't report raw reachability for them.
///
/// Each finished probe is also pushed through `on_result` (Tauri channel) as
/// soon as it completes — per-node streaming UI updates instead of one big
/// batch at the end.
#[tauri::command]
pub async fn test_nodes_latency(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    on_result: Channel<LatencyResult>,
) -> Result<LatencyBatchResult, String> {
    let nodes = load_nodes_in_display_order(&state, &ids)?;

    if nodes.is_empty() {
        return Ok(LatencyBatchResult {
            results: vec![],
            tested: 0,
            ok: 0,
            failed: 0,
            method: "none".into(),
        });
    }

    let probe_url = state.lock_store().settings.probe_url.clone();
    let clash = state.lock_runtime().clash_api_clone();

    // Manual run: never serve cached numbers — every node is really probed.
    // The fresh results are still written to the shared probe cache for
    // background consumers (smart_switch ranking/health).
    let results = probe_nodes_streaming(
        &nodes,
        timeout_ms,
        Some(30),
        clash,
        probe_url,
        |r| stream_result(&on_result, r),
        false,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Persist through the priority rule and announce to other views
    // (dashboard card, node rows) that share the same numbers.
    if let Ok(changes) = state.apply_latency_results(&results) {
        crate::state::emit_node_latency_changes(&changes);
    }

    state.with_store_mut(|store| {store.remember_probes(&results);Ok(())}).map_err(|e|e.to_string())?;
    let ok = results.iter().filter(|r| r.latency_ms.is_some()).count();
    let failed = results.len() - ok;
    let method = batch_method(&results);
    Ok(LatencyBatchResult {
        tested: results.len(),
        ok,
        failed,
        results,
        method,
    })
}

/// Fast "Ping 测试": direct TCP connect for every node, 30 concurrent —
/// deliberately bypasses the kernel even when the core is running (the
/// through-kernel path lives in [`test_nodes_latency`]). Reports raw
/// reachability only; QUIC-only protocols have no TCP port to ping and come
/// back as `unsupported`. Streams per-node results via `on_result`.
#[tauri::command]
pub async fn ping_nodes_latency(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    on_result: Channel<LatencyResult>,
) -> Result<LatencyBatchResult, String> {
    let nodes = load_nodes_in_display_order(&state, &ids)?;

    if nodes.is_empty() {
        return Ok(LatencyBatchResult {
            results: vec![],
            tested: 0,
            ok: 0,
            failed: 0,
            method: "none".into(),
        });
    }

    // Manual run — bypass cache reads, write fresh results (see test_nodes_latency).
    let results = ping_nodes_streaming(
        &nodes,
        timeout_ms,
        Some(30),
        |r| stream_result(&on_result, r),
        false,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Same shared persist+announce path — a ping only lands where it doesn't
    // paint over a real reading (priority rule in update_node_latency).
    if let Ok(changes) = state.apply_latency_results(&results) {
        crate::state::emit_node_latency_changes(&changes);
    }

    state.with_store_mut(|store| {store.remember_probes(&results);Ok(())}).map_err(|e|e.to_string())?;
    let ok = results.iter().filter(|r| r.latency_ms.is_some()).count();
    let failed = results.len() - ok;
    let method = batch_method(&results);
    Ok(LatencyBatchResult {
        tested: results.len(),
        ok,
        failed,
        results,
        method,
    })
}

/// Explicit profile probes never activate a subscription or touch main Runtime.
#[tauri::command]
pub async fn test_subscription_nodes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    ids: Vec<String>,
    through_proxy: bool,
    on_result: Channel<LatencyResult>,
) -> Result<LatencyBatchResult, String> {
    if ids.is_empty() || ids.len() > 1024 {return Err("Choose between 1 and 1024 nodes to check".into());}
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
        return Err("Duplicate node IDs in profile check".into());
    }
    let (nodes, kind, probe_url) = state.with_store(|store| {
        if !store.subscriptions.iter().any(|s|s.id==id && s.source.contributes_nodes()) {
            return Err(crate::error::AppError::NotFound(id.clone()));
        }
        let nodes = ids.iter().filter_map(|key|store.nodes.iter()
            .find(|n|n.subscription_id==id && n.node.id==*key).map(|n|n.node.clone())).collect::<Vec<_>>();
        Ok((nodes, crate::core::CoreKind::parse(&store.settings.core_type), store.settings.probe_url.clone()))
    }).map_err(|e|e.to_string())?;
    if nodes.len()!=ids.len() {return Err("The requested profile nodes changed; reopen the profile".into());}
    if through_proxy {
        if let Some(error) = crate::services::profile_probe::proxy_url_error(kind, &probe_url) {
            return Err(error.into());
        }
    }
    let _flight = if through_proxy {None} else {Some(crate::services::profile_probe::Flight::acquire()?)};
    let mut results=Vec::new();let mut supported=Vec::new();
    let tested_at=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    for node in nodes {
        let reason=if through_proxy {crate::services::profile_probe::unsupported_reason(kind,&node)}
            else if node.protocol.is_udp_only() || node.protocol==crate::domain::Protocol::WireGuard {Some("probe.no_tcp")}else{None};
        if let Some(reason)=reason {
            let r=LatencyResult{id:node.id,name:node.name,latency_ms:None,error:Some(reason.into()),tested_at,method:if through_proxy{"unsupported_proxy"}else{"unsupported"}.into()};
            stream_result(&on_result,&r);results.push(r);
        } else {supported.push(node);}
    }
    if !supported.is_empty() {
        if through_proxy {
            let root = state.app_data_dir.clone();
            let resources = app.path().resource_dir().ok();
            let core_nodes = supported.clone();
            let prepared=tauri::async_runtime::spawn_blocking(move ||
                crate::services::profile_probe::ProbeCore::start(&root, resources.as_deref(), kind, &core_nodes)
            ).await.map_err(|e|e.to_string())?;
            match prepared {
                Ok(probe)=>{
                    let batch=tokio::time::timeout(std::time::Duration::from_secs(120), probe_nodes_streaming(
                        &supported, Some(3000), Some(30), Some(probe.api.clone()), probe_url,
                        |r|stream_result(&on_result,r), false,
                    )).await.map_err(|_|"Profile check timed out".to_string())?.map_err(|e|e.to_string())?;
                    drop(probe);results.extend(batch);
                }
                Err(error)=>for node in &supported {
                    let r=LatencyResult{id:node.id.clone(),name:node.name.clone(),latency_ms:None,error:Some(error.clone()),tested_at,method:"error".into()};
                    stream_result(&on_result,&r);results.push(r);
                }
            }
        } else {
            results.extend(ping_nodes_streaming(&supported, Some(3000), Some(30), |r|stream_result(&on_result,r), false)
                .await.map_err(|e|e.to_string())?);
        }
    }
    if let Ok(changes)=state.apply_latency_results(&results) {crate::state::emit_node_latency_changes(&changes);}
    state.with_store_mut(|store| {store.remember_probes(&results);Ok(())}).map_err(|e|e.to_string())?;
    let ok=results.iter().filter(|r|r.latency_ms.is_some()).count();
    Ok(LatencyBatchResult {tested:results.len(),ok,failed:results.len()-ok,method:batch_method(&results),results})
}

/// `tcp` / `clash_api` if every result used that method, `mixed` otherwise
/// (UDP-only protocols use clash_api, the rest use tcp — see [`test_nodes_latency`]).
fn batch_method(results: &[LatencyResult]) -> String {
    let mut methods = results.iter().map(|r| r.method.as_str());
    match methods.next() {
        None => "none".into(),
        Some(first) if methods.all(|m| m == first) => first.into(),
        _ => "mixed".into(),
    }
}

/// Same direct-TCP probe as [`test_nodes_latency`], but for the read-only
/// nodes extracted from the selected custom sing-box config. Results are
/// NOT persisted — custom nodes do not live in the node store, so the UI
/// keeps them for the session only. Empty when not in custom runtime mode.
#[tauri::command]
pub async fn test_custom_nodes_latency(
    state: State<'_, AppState>,
    timeout_ms: Option<u64>,
    on_result: Channel<LatencyResult>,
) -> Result<LatencyBatchResult, String> {
    let nodes: Vec<_> = custom_config_nodes(&state)?
        .into_iter()
        .map(|listed| listed.node)
        .collect();

    if nodes.is_empty() {
        return Ok(LatencyBatchResult {
            results: vec![],
            tested: 0,
            ok: 0,
            failed: 0,
            method: "none".into(),
        });
    }

    // Always TCP — same rationale as test_nodes_latency. Manual run —
    // bypass cache reads, write fresh results.
    let results = probe_nodes_streaming(
        &nodes,
        timeout_ms,
        Some(30),
        None,
        String::new(),
        |r| stream_result(&on_result, r),
        false,
    )
    .await
    .map_err(|e| e.to_string())?;

    state.with_store_mut(|store| {store.remember_probes(&results);Ok(())}).map_err(|e|e.to_string())?;
    let ok = results.iter().filter(|r| r.latency_ms.is_some()).count();
    let failed = results.len() - ok;
    Ok(LatencyBatchResult {
        tested: results.len(),
        ok,
        failed,
        results,
        method: "tcp".into(),
    })
}
