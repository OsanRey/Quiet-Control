use crate::{
    routing::{self, Document, Draft, Query},
    state::AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
#[tauri::command(async)]
pub fn routing_workspace(state: State<'_, AppState>) -> Result<Value, String> {
    state.with_store(|s|{let active=Document::from_store(s);Ok(json!({"revision":active.revision(),"active":active,"draft":routing::read_draft(&state.app_data_dir)?.map(|mut draft|{draft.document=routing::policy::without_china(&draft.document);draft}).or_else(||{let document=routing::policy::without_china(&active);(document.revision()!=active.revision()).then(||Draft{base_revision:active.revision(),document})}),"retired_presets":active.rule_sets.iter().filter(|s|routing::policy::retired_china_set(s)).count(),"custom":s.settings.runtime_source().is_custom(),"capture":s.settings.capture_mode,"previous":std::fs::read(state.app_data_dir.join("data/routing-last-good.json")).ok().and_then(|b|serde_json::from_slice::<Document>(&b).ok())}))}).map_err(|e|e.to_string())
}
#[tauri::command(async)]
pub fn routing_save_draft(state: State<'_, AppState>, draft: Draft) -> Result<(), String> {
    routing::write_draft(&state.app_data_dir, &draft).map_err(|e| e.to_string())
}
#[tauri::command(async)]
pub fn routing_analyze(state: State<'_, AppState>, document: Document) -> Result<Value, String> {
    state
        .with_store(|s| Ok(json!({"issues":routing::issues(&document,s)})))
        .map_err(|e| e.to_string())
}
#[tauri::command(async)]
pub fn routing_predict(document: Document, query: Query) -> Result<Value, String> {
    if document.rule_sets.len() > 1000 {
        return Err("routing.draft.too_large".into());
    }
    for set in &document.rule_sets {
        for rule in &set.rules {
            crate::routing::conditions::validate(
                &crate::routing::conditions::expression(rule),
                crate::core::CoreKind::SingBox,
                0,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(routing::predict(&document, &query))
}
#[tauri::command]
pub async fn routing_validate(app: AppHandle, document: Document) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move||{let state=app.state::<AppState>();state.with_store(|s|{routing::ensure(&document,s)?;routing::validate_sources(&document,s,&state.app_data_dir)?;let mut candidate=s.clone();document.put(&mut candidate);routing::preflight(&candidate,&state.app_data_dir,app.path().resource_dir().ok().as_deref())?;Ok(json!({"checked":true,"tun_projection":false,"core":document.core,"internet_verified":false}))}).map_err(|e|e.to_string())}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn routing_apply(app: AppHandle, draft: Draft) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state
            .apply_routing_document(draft, app.path().resource_dir().ok().as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command(async)]
pub fn routing_discard(state: State<'_, AppState>) -> Result<(), String> {
    let p = state.app_data_dir.join("data/routing-draft.json");
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?
    }
    Ok(())
}
#[tauri::command(async)]
pub fn routing_templates(
    state: State<'_, AppState>,
    templates: Option<Value>,
) -> Result<Value, String> {
    let path = state.app_data_dir.join("data/routing-templates.json");
    if let Some(value) = templates {
        let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 || !value.is_array() {
            return Err("routing.templates.invalid".into());
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::storage::replace_file(&path, &bytes).map_err(|e| e.to_string())?;
        return Ok(value);
    }
    if !path.exists() {
        return Ok(json!([]));
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command(async)]
pub fn routing_processes() -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output=std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-Process | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress"]).creation_flags(0x08000000).output().map_err(|e|e.to_string())?;
        if !output.status.success() {
            return Err("routing.process.unavailable".into());
        }
        return serde_json::from_slice(&output.stdout)
            .map_err(|_| "routing.process.unavailable".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(json!([]))
    }
}
#[tauri::command(async)]
pub fn routing_export(template: Value, path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() || path.extension().and_then(|x| x.to_str()) != Some("json") {
        return Err("routing.templates.invalid".into());
    }
    let mut template = template;
    let sets = template
        .pointer_mut("/document/rule_sets")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "routing.templates.invalid".to_string())?;
    // A remote source URL may embed a subscription token; omit remote groups
    // completely rather than pretending they can be exported without secrets.
    sets.retain(|set| set.get("remote").is_none_or(|r| r.is_null()));
    let bytes = serde_json::to_vec_pretty(&template).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("routing.templates.invalid".into());
    }
    crate::storage::replace_file(&path, &bytes).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn routing_prepare_source(
    app: AppHandle,
    name: String,
    url: String,
    bytes: Option<Vec<u8>>,
    previous: Option<crate::domain::RuleSet>,
) -> Result<crate::domain::RuleSet, String> {
    use sha2::{Digest, Sha256};
    let state = app.state::<AppState>();
    let mut set = previous.unwrap_or_else(|| {
        crate::domain::RuleSet::new_remote(
            name.trim(),
            url.trim(),
            crate::domain::RuleTarget::Proxy,
        )
    });
    let remote = set
        .remote
        .as_mut()
        .ok_or_else(|| "routing.remote.incompatible".to_string())?;
    remote.url = url.trim().into();
    let result: Result<(Vec<u8>, String, u32, Option<bool>), String> = async {
        let bytes = if let Some(bytes) = bytes {
            bytes
        } else {
            let parsed =
                reqwest::Url::parse(&remote.url).map_err(|_| "routing.source.url".to_string())?;
            if !matches!(parsed.scheme(), "https" | "http") {
                return Err("routing.source.url".into());
            }
            crate::remote_rule_auto::download(&remote.url, None).await?
        };
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("routing.draft.too_large".into());
        }
        let (format, count, has_ip) = if bytes.starts_with(b"SRS") {
            let scan = crate::srs::parse(&bytes)?;
            (String::from("binary"), scan.display_count, None)
        } else {
            let (count, ip) = crate::remote_rule_auto::validate_source(&bytes)?;
            (String::from("source"), count, Some(ip))
        };
        Ok((bytes, format, count, has_ip))
    }
    .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    remote.last_attempt = Some(now);
    match result {
        Ok((bytes, format, count, has_ip)) => {
            let dir = state.app_data_dir.join("routing-cache");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let file = dir.join(format!(
                "{}.{}",
                hex::encode(Sha256::digest(&bytes)),
                if format == "binary" { "srs" } else { "json" }
            ));
            crate::storage::replace_file(&file, &bytes).map_err(|e| e.to_string())?;
            // Validate semantics with the pinned native parser before replacing the last
            // successful cache reference. A source can be structurally valid but unusable.
            let resources = app.path().resource_dir().ok();
            let app_dir = state.app_data_dir.clone();
            let source_path = file.clone();
            let source_format = format.clone();
            let validation=tauri::async_runtime::spawn_blocking(move|| -> Result<(),String> {
    let (bin,_)=crate::core::inspect_core_bin(&app_dir,resources.as_deref(),crate::core::CoreKind::SingBox);
    let bin=bin.ok_or_else(||"routing.core.missing".to_string())?;
    let config=serde_json::json!({"outbounds":[{"type":"direct","tag":"direct"}],"route":{"rule_set":[{"tag":"source-check","type":"local","format":source_format,"path":source_path}],"rules":[{"rule_set":["source-check"],"action":"route","outbound":"direct"}],"final":"direct"}});
    std::fs::create_dir_all(app_dir.join("config")).map_err(|e|e.to_string())?;
    let path=app_dir.join("config").join(format!("source-check-{}.json",std::process::id()));
    std::fs::write(&path,serde_json::to_vec(&config).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let result=crate::core::manager::CoreManager::check_config(crate::core::CoreKind::SingBox,&bin,&path).map_err(|e|e.to_string());let _=std::fs::remove_file(path);result
   }).await.map_err(|e|e.to_string())?;
            if let Err(error) = validation {
                remote.download_status = "error".into();
                remote.download_error = Some(error);
                return Ok(set);
            }
            remote.local_path = Some(file.to_string_lossy().into());
            remote.format = format;
            remote.download_status = "ready".into();
            remote.download_error = None;
            remote.last_update = Some(now);
            remote.rule_count = Some(count);
            remote.contains_ip = has_ip;
        }
        Err(error) => {
            remote.download_status = "error".into();
            remote.download_error = Some(error);
        }
    }
    Ok(set)
}
