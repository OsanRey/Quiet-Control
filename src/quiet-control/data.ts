import { q, currentLocale, type MessageKey } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCoreInfo, getProxyStatus, getSettings, listAllNodes, listSubscriptions, onNodeLatencyChanged, onProxySnapshot, peekProxyStatus, setCaptureMode, setCoreType, setCurrentNode, setOutboundMode, setRuntimeSource, startProxy, stopProxy, testNodesLatency } from "../api";
import type { AppSettings, CoreInfo, CoreKind, ProxyNode, ProxyStatus, SubscriptionView } from "../types";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import { useCoreBusy } from "../coreBusy";
import { getCoreLogTail } from "../api";
import { recentConnectionError } from "./connectionErrors";
export { diagnoseNetwork } from "../api";
export function payloadValue(status:ProxyStatus|null|undefined,key:'upload_total'|'download_total'|'upload_speed'|'download_speed') {
 const split=status?.split_traffic;
 if(split&&(split.source==='clash_connections'||split.source==='xray_outbounds'))return split.vpn[key]+split.direct[key]+split.unknown[key];
 return status?.[key];
}
export interface Sample { at: number; down: number; up: number }
/** One owner for home data, mutations and errors; all operations use the existing API. */
export function useControlData(homeVisible: boolean) {
  const coreBusy = useCoreBusy();
  const [status, setStatus] = useState<ProxyStatus | null>(peekProxyStatus);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [profiles, setProfiles] = useState<SubscriptionView[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [cores, setCores] = useState<CoreInfo[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const logSession = `${status?.core_started_at}:${status?.current_node_id}:${status?.running}`;
  const currentLogSession = useRef(logSession);
  currentLogSession.current = logSession;
  const logSince = useRef(Date.now());
  useEffect(() => { logSince.current = Date.now(); setTransportError(null); }, [logSession]);
  const [requestedCapture, setRequestedCapture] = useState<"off" | "system" | "tun" | null>(null);
  // Pending choices belong to an idle session. A start from the tray or a
  // legacy page must show the backend's applied mode, not a stale UI choice.
  useEffect(() => { if (status?.running) setRequestedCapture(null); }, [status?.running, status?.capture_mode]);
  const mounted = useRef(false);
  const flight = useRef(false);
  const graphSession = useRef('');
  const accept = useCallback((next: ProxyStatus) => {
    if (!mounted.current) return;
    setStatus(next);
    const session=String(next.split_traffic?.epoch??'')+':'+String(next.core_started_at??'');
    const changed=graphSession.current!==session;graphSession.current=session;
    setSamples(previous => {
      if(changed)previous=[];
      if (!next.running) return [];
      if(next.split_traffic?.source&&!next.split_traffic.available)return previous.filter(p=>Date.now()-p.at<=60_000);
      const now = Date.now();
      if (previous.length && now - previous[previous.length - 1].at < 850) return previous;
      return [...previous.filter(p => now - p.at <= 60_000).slice(-59), { at: now, down: payloadValue(next,"download_speed")??0, up: payloadValue(next,"upload_speed")??0 }];
    });
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextNodes, nextProfiles, nextSettings, nextCores] = await Promise.all([
        getProxyStatus(), listAllNodes(), listSubscriptions(), getSettings(), Promise.all((["singbox", "xray", "mihomo"] as const).map(getCoreInfo)),
      ]);
      if (!mounted.current) return;
      accept(nextStatus); setNodes(nextNodes); setProfiles(nextProfiles); setSettings(nextSettings); setCores(nextCores); setError(null);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setLoading(false); }
  }, [accept]);
  useEffect(() => {
    mounted.current = true;
    const offStatus = onProxySnapshot(accept);
    const offLatency = onNodeLatencyChanged(change => {
      if (mounted.current) setNodes(previous => previous.map(node => node.id === change.id ? { ...node, latency_ms: change.latency_ms, latency_at: change.latency_at, latency_method: change.method } : node));
    });
    void refresh();
    return () => { mounted.current = false; offStatus(); offLatency(); };
  }, [accept, refresh]);
  useEffect(() => { if (homeVisible) void refresh(); }, [homeVisible, refresh]);
  useVisibleInterval(async () => {
    try { await getProxyStatus(); } catch (e) { if (mounted.current) setError(String(e)); }
  }, homeVisible && !busy && !coreBusy ? (status?.running ? 1000 : 4000) : null);
  useVisibleInterval(async () => {
    const session = currentLogSession.current;
    try {
      const tail = await getCoreLogTail(160, "singbox");
      if (mounted.current && currentLogSession.current === session) {
        setTransportError(recentConnectionError(tail.lines, logSince.current, Date.now(), status?.current_node_id));
      }
    } catch { /* Do not present a log-read failure as a transport failure. */ }
  }, homeVisible && status?.running && status.core_type === "singbox" && !busy && !coreBusy ? 4000 : null);
  const run = useCallback(async (action: () => Promise<unknown>, success: MessageKey) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); await refresh(); if (mounted.current) setNotice(success); }
    catch (e) { if (mounted.current) setError(String(e)); try { await getProxyStatus(); } catch { /* keep the action error */ } }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }, [refresh]);
  const captureMode = requestedCapture ?? status?.capture_mode ?? (status?.tun_enabled ? "tun" : status?.system_proxy ? "system" : "off");
  const transition = status?.core_state === "starting" || status?.core_state === "stopping";
  return { status, nodes, profiles, settings, cores, samples, loading, captureMode, busy: busy || coreBusy || transition, error, transportError, notice: notice ? q(notice) : null, refresh,
    clearNotice: () => setNotice(null),
    connect: () => run(async () => {
      if (status?.running) return stopProxy();
      try {
        if (settings?.runtime_source?.startsWith("singbox:")) return await startProxy(false);
        const saved = await getSettings();
        if (saved.auto_select === 'off' && saved.last_manual_node_id) await setCurrentNode(saved.last_manual_node_id);
        // Stage a desired mode without pointing Windows at an unready listener.
        await setCaptureMode(captureMode === "tun" ? "tun" : "off");
        const next = await startProxy(captureMode === "system");
        setRequestedCapture(null);
        return next;
      }
      catch (error) {
        try { await stopProxy(); }
        catch (cleanup) { throw new Error(q("qc.107", {v0: String(error), v1: String(cleanup)})); }
        throw error;
      }
    }, status?.running ? "qc.108" : "qc.109"),
    selectNode: (id: string) => run(() => setCurrentNode(id), "qc.110"),
    selectCore: (kind: CoreKind) => run(() => setCoreType(kind), "qc.111"),
    selectSource: (source: string) => run(() => setRuntimeSource(source), "qc.112"),
    capture: (mode: "off" | "system" | "tun") => {
      if (flight.current) return;
      if (!status?.running && mode !== "off") {
        setRequestedCapture(mode);
        setError(null);
        setNotice("qc.113");
        return;
      }
      setRequestedCapture(null);
      return run(async () => {
      try { return await setCaptureMode(mode); }
      catch (error) {
        // A cancelled/failed elevated restart must not leave an owned Windows
        // proxy pointing at the stopped core. Reuse the backend recovery path.
        if (mode === "tun") {
          try { await stopProxy(); }
          catch (cleanup) { throw new Error(q("qc.114", {v0: String(error), v1: String(cleanup)})); }
        }
        throw error;
      }
    }, "qc.115");
    },
    outbound: (mode: "rule" | "global" | "direct") => run(() => setOutboundMode(mode), "qc.116"),
    testNode: (id: string) => run(() => testNodesLatency([id], 5000), "qc.117"),
  };
}
export type ControlData = ReturnType<typeof useControlData>;
export function formatBytes(value: number | undefined, speed = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = [q("qc.118"), q("qc.119"), q("qc.120"), q("qc.121"), q("qc.122")];
  let unit = 0; let n = Math.max(0, value);
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n.toLocaleString(currentLocale(), { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}${speed ? q("qc.123") : ""}`;
}
