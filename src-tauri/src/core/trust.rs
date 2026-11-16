use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::path::Path;

fn manifest() -> serde_json::Value {
    serde_json::from_str(include_str!("trusted-inputs.json")).expect("compiled trust manifest")
}

pub fn verify_archive(name: &str, bytes: &[u8]) -> AppResult<()> {
    let expected = manifest()["archives"][name].as_str().map(str::to_owned)
        .ok_or_else(|| AppError::Core("Unreviewed core archive: update the pinned build manifest first".into()))?;
    verify_digest(&expected, bytes)
}

fn verify_digest(expected: &str, bytes: &[u8]) -> AppResult<()> {
    if hex::encode(Sha256::digest(bytes)) != expected {
        return Err(AppError::Core("Core integrity verification failed".into()));
    }
    Ok(())
}

pub fn verify_binary(kind: super::CoreKind, path: &Path) -> AppResult<()> {
    if !cfg!(windows) { return Ok(()); }
    let name = kind.binary_name();
    let expected = manifest()["binaries"][name].as_str().map(str::to_owned)
        .ok_or_else(|| AppError::Core(format!("Unreviewed core binary: {name}")))?;
    verify_digest(&expected, &std::fs::read(path)?)?;
    for name in ["wintun.dll", "libcronet.dll"] {
        let dll=path.parent().unwrap().join(name);
        if dll.exists() {
            let expected=manifest()["binaries"][name].as_str().unwrap().to_owned();
            verify_digest(&expected,&std::fs::read(dll)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modified_or_unreviewed_downloads_are_rejected_before_execution() {
        assert!(verify_archive("untrusted.zip", b"not a core").is_err());
        assert!(verify_archive("Xray-windows-64.zip", b"tampered archive").is_err());
    }
}
