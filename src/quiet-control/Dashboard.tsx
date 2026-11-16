import { q } from "../i18n";
import { useState } from "react";
import type { CoreKind } from "../types";
import { homePanels } from "./panels";
import { formatBytes, type ControlData, type Sample } from "./data";
import { Button, Card, DataRow, Dialog, EmptyState, Icon, IconButton, Select, Skeleton, StatusIndicator, Tooltip } from "./primitives";

export type Page = "home" | "profiles" | "nodes" | "routes" | "dns" | "traffic" | "tools" | "settings" | "logs" | "advanced";
export function TrafficChart({ samples }: { samples: Sample[] }) {
  const max = Math.max(1024, ...samples.flatMap(s => [s.down, s.up]));
  const now = samples[samples.length - 1]?.at ?? 0;
  const points = (key: "down" | "up") => samples.map(s => `${600 - (now - s.at) / 60_000 * 600},${112 - s[key] / max * 98}`).join(" ");
  return <div className="qc-chart">
    <div className="qc-chart-scale"><span>{formatBytes(max, true)}</span><span>0</span></div>
    {samples.length > 1 ? <svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={q("qc.030")}><path className="qc-chart-grid" d="M0 14h600M0 63h600M0 112h600"/><polyline className="qc-chart-down" points={points("down")}/><polyline className="qc-chart-up" points={points("up")}/></svg> : <div className="qc-chart-idle"><Icon name="traffic"/><span>{samples.length ? q("qc.031") : q("qc.032")}</span></div>}
    <div className="qc-chart-axis"><span>{q("qc.033")}</span><span>{q("qc.034")}</span></div>
  </div>;
}
export function Dashboard({ data: d, navigate }: { data: ControlData; navigate: (page: Page) => void }) {
  const [confirmCapture, setConfirmCapture] = useState<"system" | "tun" | null>(null);
  const p = d.status;
  const node = d.nodes.find(n => n.id === p?.current_node_id);
  const coreKind = p?.core_type ?? d.settings?.core_type ?? "singbox";
  const core = d.cores.find(c => c.kind === coreKind);
  const custom = p?.runtime_source === "singbox" || d.settings?.runtime_source?.startsWith("singbox:");
  const source = d.settings?.runtime_source ?? "generated";
  const capture = p?.capture_mode ?? (p?.tun_enabled ? "tun" : p?.system_proxy ? "system" : "off");
  const activeNodes = [...d.nodes].sort((a, b) => Number(b.id === p?.current_node_id) - Number(a.id === p?.current_node_id) || Number(b.favorite) - Number(a.favorite)).slice(0, 4);
  const ready = Boolean(p && core?.installed && (custom || node));
  const uptime = p?.running && p.core_started_at ? Math.max(0, Math.floor(Date.now() / 1000 - p.core_started_at)) : null;
  return <>
    <header className="qc-page-heading"><div><h1>{q("qc.001")}</h1></div><Button onClick={() => navigate("profiles")}><Icon name="plus" size={17}/>{q("qc.035")}</Button></header>
    <div className="qc-dashboard">
      <Card title={q("qc.036")} className="qc-connection" action={<StatusIndicator tone={p?.error ? "danger" : p?.running ? "success" : "neutral"}>{d.busy ? q("qc.037") : p?.running ? q("qc.038") : q("qc.039")}</StatusIndicator>}>
        {d.loading ? <Skeleton/> : <>
          <div className="qc-connect-overview"><button type="button" className={`qc-power ${p?.running ? "is-on" : ""}`} disabled={d.busy || (!p?.running && !ready)} onClick={d.connect} aria-label={p?.running ? q("qc.040") : q("qc.041")}><Icon name="power" size={32}/></button><div className="qc-server-heading"><h3 title={node?.name}>{node?.name ?? (custom ? p?.runtime_profile_name ?? q("qc.042") : q("qc.043"))}</h3><p>{p?.running ? `${uptime == null ? q("qc.044") : `${Math.floor(uptime / 3600).toString().padStart(2, "0")}:${Math.floor(uptime % 3600 / 60).toString().padStart(2, "0")}:${(uptime % 60).toString().padStart(2, "0")}`} · ${p.system_proxy ? q("qc.045") : p.tun_enabled ? "TUN" : q("qc.046")}` : ready ? q("qc.047") : q("qc.048")}</p></div></div>
          <details className="qc-connection-options"><summary>{q("qc.049")}<span>{core?.name ?? "—"} · {p?.outbound_mode === "global" ? q("qc.050") : p?.outbound_mode === "direct" ? q("qc.051") : q("qc.052")}</span></summary>          <dl className="qc-connection-details"><DataRow label={q("qc.053")}><select className="qc-profile-select" aria-label={q("qc.054")} value={source} disabled={d.busy || !p} onChange={e => void d.selectSource(e.target.value)}><option value="generated">{node?.subscription_name ?? q("qc.055")}</option>{d.profiles.filter(profile => profile.source_kind === "custom").map(profile => <option key={profile.id} value={`singbox:${profile.id}`}>{profile.name}</option>)}</select></DataRow></dl>
          <div className="qc-two-fields"><Select label={q("qc.056")} value={coreKind} disabled={d.busy || d.loading || Boolean(custom)} onChange={e => void d.selectCore(e.target.value as CoreKind)}>{d.cores.map(c => <option key={c.kind} value={c.kind} disabled={!c.installed}>{c.name}{c.installed ? "" : q("qc.057")}</option>)}</Select><Select label={q("qc.004")} value={p?.outbound_mode ?? "rule"} disabled={!p || d.busy || Boolean(custom)} onChange={e => void d.outbound(e.target.value as "rule" | "global" | "direct")}><option value="rule">{q("qc.052")}</option><option value="global">{q("qc.050")}</option><option value="direct">{q("qc.058")}</option></Select></div>
</details>
          <div className="qc-connect-actions"><Button variant="ghost" onClick={d.connect} disabled={d.busy || (!p?.running && !ready)}><Icon name="power" size={17}/>{d.busy ? q("qc.037") : p?.running ? q("qc.059") : q("qc.060")}</Button><Button onClick={() => navigate("advanced")}><Icon name="settings" size={17}/>{q("qc.061")}</Button></div>
          {p?.error && <p className="qc-inline-error" role="alert">{p.error}</p>}
        </>}
      </Card>
      <Card title={q("qc.005")} className="qc-traffic" action={<Button variant="ghost" onClick={() => navigate("traffic")}>{q("qc.062")}<Icon name="arrow" size={15}/></Button>}>
        <div className="qc-speeds"><div><span className="qc-metric-label"><Icon name="down" size={16}/>{q("qc.063")}</span><strong>{formatBytes(p?.download_speed, true)}</strong><small>{q("qc.064")}{formatBytes(p?.download_total)}</small></div><div><span className="qc-metric-label"><Icon name="up" size={16}/>{q("qc.065")}</span><strong>{formatBytes(p?.upload_speed, true)}</strong><small>{q("qc.066")}{formatBytes(p?.upload_total)}</small></div></div>
        <TrafficChart samples={d.samples}/><div className="qc-chart-caption"><span><i className="qc-download-dot"/>{q("qc.063")}</span><span><i className="qc-upload-dot"/>{q("qc.065")}</span><small>{q("qc.067")}</small></div>
        <div className="qc-traffic-foot"><span>{q("qc.068")}</span><strong>{p?.connections ?? "—"}</strong></div>
      </Card>
      <Card title={q("qc.003")} className="qc-nodes" action={<Button variant="ghost" onClick={() => navigate("nodes")}>{q("qc.069")}<Icon name="arrow" size={15}/></Button>}>
        {d.loading ? <Skeleton/> : activeNodes.length ? <ul className="qc-node-list">{activeNodes.map(n => <li key={n.id} className={n.id === p?.current_node_id ? "is-selected" : ""}><button type="button" disabled={d.busy || Boolean(custom)} onClick={() => void d.selectNode(n.id)} aria-label={q("qc.070", {v0: n.name})}><span className="qc-node-symbol"><Icon name="nodes"/></span><span className="qc-node-copy"><strong title={n.name}>{n.name}</strong><small title={n.subscription_name}>{n.protocol.toUpperCase()} · {n.subscription_name ?? n.server}</small></span><span className="qc-node-latency" title={n.latency_method === "tcp" ? q("qc.071") : q("qc.072")}>{n.latency_ms != null && n.latency_ms >= 0 ? q("qc.073", {v0: n.latency_ms}) : "—"}</span>{n.id === p?.current_node_id && <Icon name="check" size={16}/>}</button><Tooltip label={q("qc.074")}><IconButton label={q("qc.075", {v0: n.name})} icon="refresh" disabled={d.busy} onClick={() => void d.testNode(n.id)}/></Tooltip></li>)}</ul> : <EmptyState title={q("qc.076")} action={<Button onClick={() => navigate("profiles")}><Icon name="plus" size={16}/>{q("qc.035")}</Button>}>{q("qc.077")}<br/>{q("qc.078")}</EmptyState>}
        {d.nodes.length > 0 && <div className="qc-card-note">{d.nodes.length} {q("qc.079")}{d.profiles.length} {q("qc.080")}</div>}
      </Card>
      <Card title={q("qc.081")} className="qc-system-card" action={<Icon name="shield" size={18}/>}>
        <dl className="qc-system"><DataRow label={q("qc.056")}><StatusIndicator tone={core?.installed ? "success" : d.loading ? "neutral" : "warning"}>{core?.installed ? `${core.name} ${core.version ?? ""}` : d.loading ? q("qc.082") : q("qc.083")}</StatusIndicator></DataRow><DataRow label={q("qc.045")}><StatusIndicator tone={p?.system_proxy ? "success" : "neutral"}>{p?.system_proxy ? q("qc.084") : q("qc.085")}</StatusIndicator></DataRow><DataRow label="TUN"><StatusIndicator tone={p?.tun_enabled && p.running ? "success" : "neutral"}>{p?.tun_enabled && p.running ? q("qc.086") : q("qc.087")}</StatusIndicator></DataRow><DataRow label="DNS"><Button variant="ghost" onClick={() => navigate("dns")}>{q("qc.088")}<Icon name="arrow" size={14}/></Button></DataRow><DataRow label={q("qc.089")}><code>{p ? `127.0.0.1:${p.mixed_port}` : "—"}</code></DataRow></dl>
        <Select label={q("qc.090")} value={capture} disabled={!p || d.busy || Boolean(custom)} onChange={e => { const mode = e.target.value as "off" | "system" | "tun"; if (mode === "off") void d.capture(mode); else setConfirmCapture(mode); }}><option value="off">{q("qc.091")}</option><option value="system">{q("qc.045")}</option><option value="tun">{q("qc.092")}</option></Select>
        <p className="qc-card-note"><Icon name="shield" size={14}/>{q("qc.093")}</p>
      </Card>
      {homePanels.map(({ id, Component }) => <Component key={id} data={d}/>)}
    </div>
    <footer className="qc-summary"><span><StatusIndicator tone={p?.running ? "success" : "neutral"}>{p?.running ? q("qc.094") : q("qc.095")}</StatusIndicator></span><span>{d.profiles.length} {q("qc.096")}{d.nodes.length} {q("qc.097")}</span><Button variant="ghost" onClick={() => navigate("logs")}>{q("qc.024")}<Icon name="arrow" size={14}/></Button></footer>
    {confirmCapture && <Dialog title={confirmCapture === "tun" ? q("qc.098") : q("qc.099")} onClose={() => setConfirmCapture(null)}><p>{confirmCapture === "tun" ? q("qc.100") : q("qc.101")}</p><p>{q("qc.102")}</p><Button variant="primary" onClick={() => { void d.capture(confirmCapture); setConfirmCapture(null); }}>{q("qc.103")}</Button></Dialog>}
  </>;
}
