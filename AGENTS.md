# Quiet Control project map

Target: Windows 11 x64; React/TypeScript in src/, Rust/Tauri in src-tauri/.
Read BUILDING.md, CONTRIBUTING.md, THIRD-PARTY-NOTICES.md and docs/release/STATUS.md.
This source uses the pre-stage46 baseline; cancelled stage46 changes are excluded.
Do not redesign networking during cleanup. Preserve CSP, trusted-core hashes,
TUN cleanup, DNS, routing, profile storage and explicit selection semantics.
Never modify a user's installed client or active network during automated checks.
Native/core/TUN acceptance belongs in an isolated VM, not the developer host.
Unit/build success is not evidence of Internet connectivity or native acceptance.
Do not commit private subscriptions, stores, HWID, logs, QA ISO, credentials or
runtime snapshots. Binary redistribution requires its own license review.
Keep lockfiles, original LICENSE and upstream attribution. Upstream changes
must be reviewed in an integration branch before merging into this fork.
Local research history is preserved separately; never push all local refs.
