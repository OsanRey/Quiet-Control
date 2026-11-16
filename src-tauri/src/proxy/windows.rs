//! Windows system HTTP(S)/SOCKS proxy via the registry + WinINet refresh.
//!
//! Writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
//! (ProxyEnable, ProxyServer, ProxyOverride) and signals WinINet so apps pick
//! up the change immediately. On disable we restore whatever ProxyServer /
//! ProxyOverride values we overwrote, so the user's prior config survives.
//!
//! We hand-roll the handful of Win32 FFI symbols (no windows-sys dependency),
//! matching the approach used in core/job.rs.

#![cfg(target_os = "windows")]

use super::{SystemProxy, SystemProxySnapshot};
use crate::error::{AppError, AppResult};
use core::ffi::c_void as CVoid;
use std::ffi::OsStr;
use std::os::windows::process::CommandExt;
use std::os::windows::ffi::OsStrExt;

// --- Minimal Win32 FFI -------------------------------------------------------

type BOOL = i32;
type DWORD = u32;
type LONG = i32;
type HKEY = *mut CVoid;
type PHKEY = *mut HKEY;
type LPCWSTR = *const u16;

const HKEY_CURRENT_USER: HKEY = 0x8000_0001usize as HKEY;
const KEY_QUERY_VALUE: DWORD = 0x0001;
const KEY_SET_VALUE: DWORD = 0x0002;
const REG_SZ: DWORD = 1;
const REG_DWORD: DWORD = 4;
const ERROR_SUCCESS: LONG = 0;
const ERROR_FILE_NOT_FOUND: LONG = 2;

const INTERNET_OPTION_SETTINGS_CHANGED: DWORD = 39;
const INTERNET_OPTION_REFRESH: DWORD = 37;

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hKey: HKEY,
        lpSubKey: LPCWSTR,
        ulOptions: DWORD,
        samDesired: DWORD,
        phkResult: PHKEY,
    ) -> LONG;
    fn RegSetValueExW(
        hKey: HKEY,
        lpValueName: LPCWSTR,
        Reserved: DWORD,
        dwType: DWORD,
        lpData: *const u8,
        cbData: DWORD,
    ) -> LONG;
    fn RegQueryValueExW(
        hKey: HKEY,
        lpValueName: LPCWSTR,
        lpReserved: *mut DWORD,
        lpType: *mut DWORD,
        lpData: *mut u8,
        lpcbData: *mut DWORD,
    ) -> LONG;
    fn RegCloseKey(hKey: HKEY) -> LONG;
    fn RegDeleteValueW(hKey: HKEY, lpValueName: LPCWSTR) -> LONG;
}

#[link(name = "wininet")]
extern "system" {
    fn InternetSetOptionW(
        hInternet: *mut CVoid,
        dwOption: DWORD,
        lpBuffer: *mut CVoid,
        dwBufferLength: DWORD,
    ) -> BOOL;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut CVoid;
    fn WaitForSingleObject(handle: *mut CVoid, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut CVoid) -> i32;
}

/// Encode a Rust string as UTF-16 **with** a trailing NUL, as Win32 expects.
fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Open HKCU\...\Internet Settings for writing.
fn open_internet_settings() -> AppResult<HKEY> {
    let sub = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
    let mut h: HKEY = core::ptr::null_mut();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut h as *mut HKEY,
        )
    };
    if rc != ERROR_SUCCESS || h.is_null() {
        return Err(AppError::Core(format!(
            "RegOpenKeyExW Internet Settings failed (rc={rc})"
        )));
    }
    Ok(h)
}

fn query_dword(h: HKEY, name: &str) -> AppResult<Option<DWORD>> {
    let name = wide(name);
    let mut kind = 0;
    let mut value = 0;
    let mut size = core::mem::size_of::<DWORD>() as DWORD;
    let rc = unsafe {
        RegQueryValueExW(
            h,
            name.as_ptr(),
            core::ptr::null_mut(),
            &mut kind,
            (&mut value as *mut DWORD).cast::<u8>(),
            &mut size,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if rc != ERROR_SUCCESS || kind != REG_DWORD {
        return Err(AppError::Core(format!(
            "RegQueryValueExW dword failed (rc={rc}, type={kind})"
        )));
    }
    Ok(Some(value))
}

fn query_sz(h: HKEY, name: &str) -> AppResult<Option<String>> {
    let name = wide(name);
    let mut kind = 0;
    let mut size = 0;
    let rc = unsafe {
        RegQueryValueExW(
            h,
            name.as_ptr(),
            core::ptr::null_mut(),
            &mut kind,
            core::ptr::null_mut(),
            &mut size,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if rc != ERROR_SUCCESS || kind != REG_SZ {
        return Err(AppError::Core(format!(
            "RegQueryValueExW string size failed (rc={rc}, type={kind})"
        )));
    }
    let mut buffer = vec![0u16; (size as usize / 2).max(1)];
    let rc = unsafe {
        RegQueryValueExW(
            h,
            name.as_ptr(),
            core::ptr::null_mut(),
            &mut kind,
            buffer.as_mut_ptr().cast::<u8>(),
            &mut size,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(AppError::Core(format!(
            "RegQueryValueExW string failed (rc={rc})"
        )));
    }
    let len = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    Ok(Some(String::from_utf16_lossy(&buffer[..len])))
}

fn proxy_server_is_exact_endpoint(value: &str, host: &str, port: u16) -> bool {
    let expected = format!("{}:{port}", host.trim().to_ascii_lowercase());
    let endpoints: Vec<_> = value
        .split(';')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            Some(
                part.split_once('=')
                    .map(|(_, endpoint)| endpoint)
                    .unwrap_or(part)
                    .trim()
                    .to_ascii_lowercase(),
            )
        })
        .collect();
    !endpoints.is_empty() && endpoints.iter().all(|endpoint| endpoint == &expected)
}

fn set_dword(h: HKEY, name: &str, value: DWORD) -> AppResult<()> {
    let n = wide(name);
    let rc = unsafe {
        RegSetValueExW(
            h,
            n.as_ptr(),
            0,
            REG_DWORD,
            (&value as *const DWORD).cast::<u8>(),
            core::mem::size_of::<DWORD>() as DWORD,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(AppError::Core(format!(
            "RegSetValueExW {name} failed (rc={rc})"
        )));
    }
    Ok(())
}

fn set_sz(h: HKEY, name: &str, value: &str) -> AppResult<()> {
    let n = wide(name);
    let bytes = wide(value);
    let cb = (bytes.len() * 2) as DWORD; // includes trailing NUL, in bytes
    let rc = unsafe { RegSetValueExW(h, n.as_ptr(), 0, REG_SZ, bytes.as_ptr().cast::<u8>(), cb) };
    if rc != ERROR_SUCCESS {
        return Err(AppError::Core(format!(
            "RegSetValueExW {name} failed (rc={rc})"
        )));
    }
    Ok(())
}

/// Tell WinINet (and most Win32 apps / Chrome / Edge) to reload proxy settings.
fn notify_changed() {
    unsafe {
        // Both options are needed: SETTINGS_CHANGED invalidates the cache,
        // REFRESH forces an immediate reload.
        InternetSetOptionW(
            core::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            core::ptr::null_mut(),
            0,
        );
        InternetSetOptionW(
            core::ptr::null_mut(),
            INTERNET_OPTION_REFRESH,
            core::ptr::null_mut(),
            0,
        );
    }
}

pub struct WindowsSystemProxy;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct RestoreJournal {
    pid: u32,
    owned_server: String,
    previous_enabled: Option<u32>,
    previous_server: Option<String>,
    previous_override: Option<String>,
}

const OWNED_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;192.168.*;<local>";

fn journal_path() -> AppResult<std::path::PathBuf> {
    crate::portable::app_data_dir()
        .map(|root| root.join("data/system-proxy-restore.json"))
        .ok_or_else(|| AppError::Core("Research system proxy requires portable.flag".into()))
}

fn read_journal() -> Option<RestoreJournal> {
    serde_json::from_slice(&std::fs::read(journal_path().ok()?).ok()?).ok()
}

fn delete_value(h: HKEY, name: &str) -> AppResult<()> {
    let rc = unsafe { RegDeleteValueW(h, wide(name).as_ptr()) };
    if rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND { Ok(()) }
    else { Err(AppError::Core(format!("delete {name}: {rc}"))) }
}

fn restore_values(h: HKEY, journal: &RestoreJournal) -> AppResult<()> {
    for (name, value) in [("ProxyServer", &journal.previous_server), ("ProxyOverride", &journal.previous_override)] {
        match value { Some(value) => set_sz(h, name, value)?, None => delete_value(h, name)? }
    }
    match journal.previous_enabled {
        Some(value) => set_dword(h, "ProxyEnable", value),
        None => delete_value(h, "ProxyEnable"),
    }
}

fn still_owned(h: HKEY, journal: &RestoreJournal) -> AppResult<bool> {
    Ok(query_dword(h, "ProxyEnable")? == Some(1)
        && query_sz(h, "ProxyServer")?.as_deref() == Some(journal.owned_server.as_str())
        && query_sz(h, "ProxyOverride")?.as_deref() == Some(OWNED_OVERRIDE))
}

impl SystemProxy for WindowsSystemProxy {
    fn enable(&self, host: &str, port: u16) -> AppResult<SystemProxySnapshot> {
        let path = journal_path()?;
        if path.exists() {
            self.disable(None)?;
        }
        let h = open_internet_settings()?;
        let operation: AppResult<_> = (|| {
            let journal = RestoreJournal {
                pid: std::process::id(),
                owned_server: format!("{host}:{port}"),
                previous_enabled: query_dword(h, "ProxyEnable")?,
                previous_server: query_sz(h, "ProxyServer")?,
                previous_override: query_sz(h, "ProxyOverride")?,
            };
            let raw = serde_json::to_string(&journal).map_err(|e| AppError::Core(e.to_string()))?;
            std::fs::create_dir_all(path.parent().unwrap())?;
            let tmp = path.with_extension("tmp");
            let mut file = std::fs::File::create(&tmp)?;
            std::io::Write::write_all(&mut file, raw.as_bytes())?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(tmp, &path)?;
            // Start a non-elevated recovery process before changing the registry.
            // It waits on this process handle, rather than polling a reusable PID.
            let watchdog = std::process::Command::new(std::env::current_exe()?)
                .args(["--proxy-recovery-watchdog", &std::process::id().to_string()])
                .creation_flags(0x08000000)
                .spawn();
            if let Err(error) = watchdog {
                let _ = std::fs::remove_file(&path);
                return Err(AppError::Core(format!("recovery watchdog: {error}")));
            }
            let apply = (|| {
                set_sz(h, "ProxyServer", &journal.owned_server)?;
                set_sz(h, "ProxyOverride", OWNED_OVERRIDE)?;
                set_dword(h, "ProxyEnable", 1)
            })();
            if let Err(error) = apply {
                if restore_values(h, &journal).is_ok() { let _ = std::fs::remove_file(&path); }
                return Err(error);
            }
            Ok(SystemProxySnapshot { detail: raw })
        })();
        unsafe { RegCloseKey(h) };
        notify_changed();
        operation
    }

    fn disable(&self, snapshot: Option<&SystemProxySnapshot>) -> AppResult<()> {
        let journal = snapshot.and_then(|s| serde_json::from_str::<RestoreJournal>(&s.detail).ok())
            .or_else(read_journal);
        let Some(journal) = journal else { return Ok(()) };
        let h = open_internet_settings()?;
        let operation: AppResult<_> = (|| {
            // Another client or the user may have changed any owned value.
            // Do not overwrite their newer settings, even during crash recovery.
            if still_owned(h, &journal)? { restore_values(h, &journal)?; }
            Ok(())
        })();
        unsafe { RegCloseKey(h) };
        operation?;
        if let Ok(path) = journal_path() { let _ = std::fs::remove_file(path); }
        notify_changed();
        Ok(())
    }

    fn detect_owned(&self, host: &str, port: u16) -> AppResult<Option<SystemProxySnapshot>> {
        let Some(journal) = read_journal() else { return Ok(None) };
        if journal.owned_server != format!("{host}:{port}") { return Ok(None) }
        let h = open_internet_settings()?;
        let owned = still_owned(h, &journal);
        unsafe { RegCloseKey(h) };
        if owned? {
            Ok(Some(SystemProxySnapshot { detail: serde_json::to_string(&journal)
                .map_err(|e| AppError::Core(e.to_string()))? }))
        } else { Ok(None) }
    }
}

pub fn run_recovery_watchdog(pid: u32) -> i32 {
    let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
    if handle.is_null() { return 2; }
    let status = unsafe { WaitForSingleObject(handle, 0xFFFFFFFF) };
    unsafe { CloseHandle(handle) };
    if status != 0 { return 3; }
    if read_journal().map(|j| j.pid) == Some(pid) {
        if WindowsSystemProxy.disable(None).is_err() { return 4; }
    }
    0
}

pub(super) fn recover_stale_journal() -> AppResult<Option<bool>> {
    let Some(journal) = read_journal() else { return Ok(None) };
    let h = open_internet_settings()?;
    let owned = still_owned(h, &journal);
    unsafe { RegCloseKey(h) };
    let owned = owned?;
    WindowsSystemProxy.disable(None)?;
    Ok(Some(owned))
}

#[cfg(test)]
mod tests {
    use super::proxy_server_is_exact_endpoint;

    #[test]
    fn recognizes_only_an_exact_owned_proxy_server() {
        assert!(proxy_server_is_exact_endpoint(
            "127.0.0.1:2080",
            "127.0.0.1",
            2080
        ));
        assert!(proxy_server_is_exact_endpoint(
            "http=127.0.0.1:2080;https=127.0.0.1:2080;socks=127.0.0.1:2080",
            "127.0.0.1",
            2080
        ));
        assert!(!proxy_server_is_exact_endpoint(
            "http=127.0.0.1:2080;https=proxy.example:8080",
            "127.0.0.1",
            2080
        ));
        assert!(!proxy_server_is_exact_endpoint(
            "127.0.0.1:2081",
            "127.0.0.1",
            2080
        ));
    }
}
