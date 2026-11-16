import { redactSecrets } from "../quiet-control/privacy";
import {describeImportSkip,isServiceEntry} from "../quiet-control/importReport";
import {explainOperationError} from '../quiet-control/operationErrors';
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  activateSubscription,
  addSubscriptionCustom,
  addSubscriptionFile,
  addSubscriptionNode,
  addSubscriptionText,
  addSubscriptionUrl,
  getSettings,
  getProxyStatus,
  getSubscription,
  getSubscriptionCoreSupport,
  getSubscriptionRawConfig,
  listSubscriptions,
  listSubscriptionNodes,
  testSubscriptionNodes,
  listSubscriptionUrls,
  peekSettings,
  refreshSubscription,
  removeSubscription,
  setMixMode,
  setCurrentNode,
  startProxy,
  stopProxy,
  updateSettings,
  toggleFavoriteNode,
  updateSubscription,
} from "../api";
import {
  AddConfigModal,
  type ConfigFormValues,
} from "../components/AddConfigModal";
import { EditLocalNodesModal } from "../components/EditLocalNodesModal";
import { GlassButton } from "../components/GlassButton";
import { GlassSwitch } from "../components/GlassSwitch";
import { useImportIntent } from "../ImportIntentContext";
import { getVersion } from "@tauri-apps/api/app";
import { useI18n } from "../i18n";
import { ErrorModal } from "../components/ErrorModal";
import { useCoreBusy, trackCoreBusy } from "../coreBusy";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import type {
  CoreSupportReport,
  ImportResult,
  SubscriptionTraffic,
  SubscriptionUrlEntry,
  SubscriptionView,
  ProxyNode,
  LatencyResult,
  AppSettings,
  ProxyStatus,
} from "../types";


const REFRESH_ALL_CONCURRENCY = 4;

/** One subscription's skipped-node report entry (import / manual refresh). */
interface SkippedReport {
  name: string;
  source: string;
  format: string | null;
  imported: number;
  skipped: { name?: string | null; reason: string }[];
}

function skippedEntry(result: ImportResult): SkippedReport {
  return {
    name: result.subscription.name,
    imported: result.node_count,
    source: redactSecrets(result.subscription.source_display),
    format: result.subscription.format ?? null,
    skipped: result.skipped ?? [],
  };
}

async function settleWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await task(values[index] as T),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function formatTime(ts: number) {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

/** Relative time for "Last Update" (e.g. 5 minutes ago). */
function formatRelative(
  ts: number,
  t: (key: import("../i18n").MessageKey, vars?: Record<string, string | number>) => string,
) {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (sec < 60) return t("common.justNow");
  if (sec < 3600) return t("common.minutesAgo", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("common.hoursAgo", { n: Math.floor(sec / 3600) });
  if (sec < 86400 * 30) return t("common.daysAgo", { n: Math.floor(sec / 86400) });
  return formatTime(ts);
}

function formatExpireDate(ts: number) {
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function fmtBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

type TrafficView = {
  used: number;
  total: number | null;
  remaining: number | null;
  ratio: number | null;
  expire: number | null;
  expireText: string | null;
};

/** used = upload + download; remaining = total - used (or explicit remaining). */
function trafficStats(t: SubscriptionTraffic | null | undefined): TrafficView | null {
  if (!t) return null;
  const upload = t.upload ?? 0;
  const download = t.download ?? 0;
  const usedFromParts = upload + download;
  const total = t.total && t.total > 0 ? t.total : null;
  const remainingExplicit =
    t.quota_remaining != null && t.quota_remaining >= 0
      ? t.quota_remaining
      : null;

  let used = usedFromParts;
  let remaining: number | null = remainingExplicit;

  if (total != null) {
    if (usedFromParts > 0) {
      remaining = Math.max(0, total - usedFromParts);
    } else if (remaining != null) {
      used = Math.max(0, total - remaining);
    } else {
      remaining = total;
      used = 0;
    }
  }

  let ratio: number | null = null;
  if (total != null && total > 0) {
    ratio = Math.min(1, Math.max(0, used / total));
  }

  const expire = t.expire && t.expire > 0 ? t.expire : null;
  const expireText = t.expire_text?.trim() || null;

  if (
    total == null &&
    remaining == null &&
    used === 0 &&
    expire == null &&
    !expireText
  ) {
    return null;
  }
  return { used, total, remaining, ratio, expire, expireText };
}

/** Provider remark headers carry Chinese expire phrases (e.g. `长期有效`).
 *  Map the well-known ones for non-zh display; anything else passes through
 *  verbatim — it is provider-authored text, not ours. */
function localizeExpireText(text: string, locale: string, neverLabel: string): string {
  if (locale !== "zh") {
    const key = text.trim();
    if (key === "长期有效" || key === "永久有效") return neverLabel;
  }
  return text;
}

/** Config-type pill label: custom profiles show their kernel; node
 *  subscriptions show the detected source format (clash_yaml → mihomo,
 *  singbox_json → sing-box, URI lists → URI). Null = no pill (manual). */
function typeTagLabel(
  t: (key: import("../i18n").MessageKey) => string,
  item: SubscriptionView,
): string | null {
  if (item.source_kind === "custom") {
    if (item.custom_kind === "mihomo") return t("config.typeMihomo");
    if (item.custom_kind === "xray") return t("config.typeXray");
    return t("config.typeSingbox");
  }
  switch (item.format) {
    case "clash_yaml":
      return t("config.typeMihomo");
    case "xray_json":
      return t("config.typeXray");
    case "singbox_json":
      return t("config.typeSingbox");
    case "uri_list":
      return t("config.typeUri");
    case "base64_uri_list":
      return t("config.typeBase64Uri");
    default:
      return null;
  }
}

/** Compact FlClash-style traffic: thin bar + "used / total · expire". */
function TrafficBlock({ traffic }: { traffic?: SubscriptionTraffic | null }) {  const { t, locale } = useI18n();
  const tr = trafficStats(traffic);
  if (!tr) return null;

  const expireLabel = tr.expireText
    ? localizeExpireText(tr.expireText, locale, t("config.expireNever"))
    : tr.expire != null
      ? formatExpireDate(tr.expire)
      : null;

  // Full userinfo: progress = used/total (hide when total==0, same as FlClash)
  if (tr.total != null && tr.total > 0 && tr.ratio != null) {
    const barWidth = Math.min(100, Math.max(0, tr.ratio * 100));
    const level =
      tr.ratio >= 0.9 ? "critical" : tr.ratio >= 0.7 ? "warn" : "ok";
    const pct = Math.round(tr.ratio * 100);
    return (
      <div className="traffic-block">
        <div
          className="traffic-bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`traffic-bar-fill ${level}`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="traffic-line">
          <span>
            {fmtBytes(tr.used)} / {fmtBytes(tr.total)}
          </span>
          {expireLabel && <span className="dot-sep">·</span>}
          {expireLabel && (
            <span className="traffic-expire">
              {expireLabel}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Remaining-only fallback
  if (tr.remaining != null || expireLabel) {
    return (
      <div className="traffic-block">
        <div className="traffic-line">
          {tr.remaining != null && (
            <span>{t("common.remaining", { n: fmtBytes(tr.remaining) })}</span>
          )}
          {tr.remaining != null && expireLabel && (
            <span className="dot-sep">·</span>
          )}
          {expireLabel && (
            <span className="traffic-expire">
              {expireLabel}
            </span>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function ConfigGroup({
  title,
  empty,
  items,
  renderCard,
  hideEmpty=false,
}: {
  title: string;
  empty: string;
  items: SubscriptionView[];
  renderCard: (item: SubscriptionView) => ReactNode;
  hideEmpty?: boolean;
}) {
  if(hideEmpty&&items.length===0)return null;
  return (
    <section className="config-group">
      <h2 className="config-group-title">{title}</h2>
      {items.length === 0 ? (
        <p className="config-group-empty muted">{empty}</p>
      ) : (
        <div className="sub-grid">{items.map((item) => renderCard(item))}</div>
      )}
    </section>
  );
}

export function ConfigPage({managementOnly=false,onChanged,onSourceSelected}:{managementOnly?:boolean;onChanged?:()=>void;onSourceSelected?:(id:string)=>void}={}) {
  const { t } = useI18n();
  const { prefill, token, consume, dismiss } = useImportIntent();
  const [items, setItems] = useState<SubscriptionView[]>([]);
  const [viewedProfile, setViewedProfile] = useState<SubscriptionView | null>(null);
  const [profileSettings, setProfileSettings] = useState<AppSettings | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProxyStatus | null>(null);
  const [profileSort, setProfileSort] = useState('default');
  const [profileTestKind, setProfileTestKind] = useState<'tcp'|'proxy'>(()=>peekSettings()?.core_type==='xray'?'tcp':'proxy');
  const coreBusy=useCoreBusy();
  useVisibleInterval(async()=>{try{setProfileStatus(await getProxyStatus());}catch{/* keep last confirmed status */}},2500);
  const [profileNodes, setProfileNodes] = useState<ProxyNode[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileQuery, setProfileQuery] = useState('');
  const [selectingNode, setSelectingNode] = useState(false);
  const [profileTesting, setProfileTesting] = useState<Set<string>>(new Set());
  const [profileResults, setProfileResults] = useState<Map<string, LatencyResult>>(new Map());
  useEffect(() => {
    if (!viewedProfile || managementOnly) return;
    let cancelled = false;
    setProfileNodes([]);setProfileResults(new Map());setProfileQuery('');setProfileError(null);setProfileLoading(true);
    // Reads the persisted node cache, including inactive subscriptions. No fetch,
    // enable mutation or core restart is allowed while merely browsing.
    void listSubscriptionNodes(viewedProfile.id).then(nodes => {
      if (!cancelled) setProfileNodes(nodes);
    }).catch(error => {if (!cancelled) setProfileError(String(error));})
      .finally(() => {if (!cancelled) setProfileLoading(false);});
    return () => {cancelled = true;};
  }, [viewedProfile?.id]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [skippedReport, setSkippedReport] = useState<SkippedReport[] | null>(null);
  const [skippedCopied, setSkippedCopied] = useState(false);
  // Seed from the cross-mount settings snapshot (see api.ts) so the header
  // mix switch paints its persisted position on re-mount without sliding.
  const [mixMode, setMixModeState] = useState(
    () => peekSettings()?.mix_mode ?? false,
  );
  const [runtimeSource, setRuntimeSource] = useState("generated");

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editInitial, setEditInitial] = useState<ConfigFormValues | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [existingUrls, setExistingUrls] = useState<SubscriptionUrlEntry[]>([]);

  const [actionId, setActionId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteTarget,setDeleteTarget]=useState<SubscriptionView|null>(null);
  const [deleteBlocked,setDeleteBlocked]=useState(false);
  const [renameProfile, setRenameProfile] = useState<SubscriptionView | null>(
    null,
  );
  // Raw-config viewer: `null` = closed, body starts undefined (loading).
  const [rawProfile, setRawProfile] = useState<SubscriptionView | null>(null);
  const [rawBody, setRawBody] = useState<string | null | undefined>(undefined);
  const [revealRaw, setRevealRaw] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);
  // Core-support panel: `null` = closed, report starts undefined (loading).
  const [supportProfile, setSupportProfile] = useState<SubscriptionView | null>(null);
  const [supportReport, setSupportReport] = useState<CoreSupportReport | null | undefined>(
    undefined,
  );
  const [supportCopied, setSupportCopied] = useState(false);

  const busy = refreshingAll || actionId != null || selectingNode || profileTesting.size > 0 || coreBusy;

  const reload = useCallback(async () => {
    setListError(null);
    try {
      const [list, settings] = await Promise.all([
        listSubscriptions(),
        getSettings(),
      ]);
      setItems(list);
      onChanged?.();
      setMixModeState(!!settings.mix_mode);
      setRuntimeSource(settings.runtime_source || "generated");
      setProfileSettings(settings);
      if(settings.core_type==='xray')setProfileTestKind('tcp');
      setProfileStatus(await getProxyStatus());
      setViewedProfile(previous=>previous&&list.some(p=>p.id===previous.id)?previous:list.find(p=>p.source_kind!=='custom'&&p.enabled)??list.find(p=>p.source_kind!=='custom')??null);
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;
    setExistingUrls([]);
    void listSubscriptionUrls()
      .then((entries) => {
        if (cancelled) return;
        setExistingUrls(entries);
      })
      .catch(() => {
        if (!cancelled) setExistingUrls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [modalOpen, items.length]);

  // One-click subscribe deep link → open add modal with URL/name filled.
  useEffect(() => {
    if (!token || !prefill) return;
    setEditId(null);
    setImportError(null);
    setEditInitial({
      name: prefill.name ?? "",
      kind: "url",
      url: prefill.url,
      autoUpdate: true,
      autoUpdateIntervalMin: 1440,
    });
    setModalOpen(true);
    consume();
  }, [token, prefill, consume]);

  useEffect(() => {
    if (!menuId) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-sub-menu]")) return;
      setMenuId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuId(null);
    }
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  async function pickProfileNode(id: string) {
    if (busy || runtimeSource !== "generated") return;
    setSelectingNode(true);
    setProfileError(null);
    try {
      await setCurrentNode(id);
      await reload();
    } catch (error) {
      setProfileError(String(error));
    } finally {
      setSelectingNode(false);
    }
  }

  async function checkProfileNodes(throughProxy: boolean, ids: string[]) {
    if (busy || !viewedProfile || !ids.length) return;
    setProfileError(null);setProfileTesting(new Set(ids));
    setProfileResults(previous => {const next=new Map(previous);for(const id of ids)next.delete(id);return next;});
    const accept = (r: LatencyResult) => {
      setProfileResults(previous => new Map(previous).set(r.id,r));
      // Keep the operation busy until the temporary child is stopped too.
    };
    try {
      const batch = await testSubscriptionNodes(viewedProfile.id, ids, throughProxy, accept);
      for (const result of batch.results) accept(result);
    } catch (error) {setProfileError(String(error));}
    finally {setProfileTesting(new Set());}
  }

  async function changeProfileMode(mode: 'off'|'smart'|'kernel') {
    if(busy)return;setSelectingNode(true);setProfileError(null);
    try{await trackCoreBusy(updateSettings({autoSelect:mode}),700);await reload();}catch(error){setProfileError(String(error));}
    finally{setSelectingNode(false);}
  }

  async function toggleProfileConnection() {
    if(busy)return;setSelectingNode(true);setProfileError(null);
    try{if(profileStatus?.running)await stopProxy();else await startProxy(profileSettings?.capture_mode==='system');await reload();}
    catch(error){setProfileError(String(error));}finally{setSelectingNode(false);}
  }

  async function onActivate(id: string) {
    if (busy) return;
    setListError(null);
    try {
      const list = await activateSubscription(id);
      setItems(list);
      onChanged?.();
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    }
  }

  async function onToggleMix() {
    if (busy) return;
    setListError(null);
    try {
      const next = !mixMode;
      const settings = await setMixMode(next);
      setMixModeState(!!settings.mix_mode);
      // policy may collapse multi-enabled → reload list
      const list = await listSubscriptions();
      setItems(list);
      onChanged?.();
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    }
  }

  function openAdd() {
    setEditId(null);
    setEditInitial(null);
    setImportError(null);
    setModalOpen(true);
  }

  async function openEdit(id: string) {
    setImportError(null);
    setActionId(id);
    try {
      const d = await getSubscription(id);
      setEditId(id);
      const kind =
        d.source_kind === "file" ||
        d.source_kind === "text" ||
        d.source_kind === "node" ||
        d.source_kind === "custom"
          ? d.source_kind
          : "url";
      const isUriOnlyNode =
        kind === "node" && !!(d.uri && !(d.node && d.node.server));
      setEditInitial({
        name: d.name,
        kind: isUriOnlyNode ? "text" : kind,
        url: d.url ?? "",
        path: d.path ?? "",
        content: d.content ?? (isUriOnlyNode ? (d.uri ?? "") : ""),
        uri: d.uri ?? "",
        node: isUriOnlyNode ? undefined : (d.node ?? undefined),
        viaProxy: d.via_proxy,
        autoUpdate: !!d.auto_update,
        autoUpdateIntervalMin: d.auto_update_interval_min ?? 1440,
        userAgent: d.user_agent ?? "",
        http: d.http,
      });
      setModalOpen(true);
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    } finally {
      setActionId(null);
    }
  }

  async function handleSubmit(payload: ConfigFormValues) {
    setImporting(true);
    setImportError(null);
    let importResult: ImportResult | null = null;
    try {
      const name = payload.name || null;
      const autoUpdate = !!payload.autoUpdate;
      const autoUpdateIntervalMin = payload.autoUpdateIntervalMin ?? 1440;
      if (editId) {
        importResult = await updateSubscription({
          id: editId,
          name,
          kind: payload.kind,
          url: payload.url ?? null,
          path: payload.path ?? null,
          content: payload.content ?? null,
          uri: payload.uri ?? null,
          node: payload.node ?? null,
          viaProxy: payload.viaProxy ?? false,
          autoUpdate,
          autoUpdateIntervalMin,
          userAgent: payload.userAgent ?? null,
          http: payload.http,
        });
      } else if (payload.kind === "url") {
        importResult = await addSubscriptionUrl(
          name,
          payload.url ?? "",
          !!payload.viaProxy,
          autoUpdate,
          autoUpdateIntervalMin,
          payload.userAgent ?? null,
          payload.http,
        );
      } else if (payload.kind === "file") {
        importResult = await addSubscriptionFile(
          name,
          payload.path ?? "",
          autoUpdate,
          autoUpdateIntervalMin,
        );
      } else if (payload.kind === "text") {
        importResult = await addSubscriptionText(name, payload.content ?? "");
      } else if (payload.kind === "custom") {
        importResult = await addSubscriptionCustom(name, payload.content ?? "", null);
      } else {
        importResult = await addSubscriptionNode(
          name,
          payload.uri ?? null,
          payload.node ?? null,
        );
      }
      setModalOpen(false);
      setEditId(null);
      setEditInitial(null);
      dismiss();
      await reload();
      if(importResult&&importResult.subscription.source_kind!=='custom'){setViewedProfile(importResult.subscription);setProfileNodes(await listSubscriptionNodes(importResult.subscription.id));}
      maybeReportSkipped(importResult);
    } catch (e) {
      setImportError(typeof e === "string" ? e : String(e));
    } finally {
      setImporting(false);
    }
  }

  /** Import/refresh produced skipped nodes → surface the report dialog. */
  function maybeReportSkipped(result: ImportResult | null) {
    if (result?.skipped?.length) setSkippedReport([skippedEntry(result)]);
  }

  async function copySkippedReport() {
    if (!skippedReport) return;
    let version = "";
    try {
      version = await getVersion();
    } catch {
      version = "?";
    }
    const total = skippedReport.reduce((n, r) => n + r.skipped.length, 0);
    const lines = [
      t("config.reportTitle", { v: version }),
      t("importReport.skipped", { n: total }),
    ];
    for (const r of skippedReport) {
      lines.push(
        ``,
        `${t("config.reportProfile", { name: r.name })}${r.format ? `（${r.format}）` : ""}`,
        t("config.reportSource", { source: r.source }),
      );
      lines.push(t("importReport.accepted",{n:r.imported}), t("importReport.service",{n:r.skipped.filter(item=>isServiceEntry(item.reason)).length}));
      r.skipped.forEach((item, i) => {
        lines.push(`  ${i + 1}. ${item.name || t("config.skippedUnnamed")} — ${describeImportSkip(item.reason)} [${item.reason}]`);
      });
    }
    const text = redactSecrets(lines.join("\n"));
    try {
      await navigator.clipboard.writeText(text);
      setSkippedCopied(true);
      window.setTimeout(() => setSkippedCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setSkippedCopied(true);
      window.setTimeout(() => setSkippedCopied(false), 1500);
    }
  }

  async function onRefresh(id: string) {
    setActionId(id);
    setListError(null);
    try {
      const result = await refreshSubscription(id);
      await reload();
      if(viewedProfile?.id===id)setProfileNodes(await listSubscriptionNodes(id));
      maybeReportSkipped(result);
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    } finally {
      setActionId(null);
    }
  }

  /** Refresh subscriptions in a bounded pool to avoid request and parse bursts. */
  async function onRefreshAll() {
    const remotes = items.filter((item) => item.source_kind === "url");
    if (remotes.length === 0 || refreshingAll) return;
    setRefreshingAll(true);
    setListError(null);
    try {
      const results = await settleWithConcurrency(
        remotes,
        REFRESH_ALL_CONCURRENCY,
        (item) => refreshSubscription(item.id),
      );
      const failed: string[] = [];
      const skippedReports: SkippedReport[] = [];
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const name = remotes[i]?.name ?? remotes[i]?.id ?? "?";
          const reason =
            typeof r.reason === "string"
              ? r.reason
              : r.reason != null
                ? String(r.reason)
                : "unknown";
          failed.push(`${name}: ${reason}`);
        } else if (r.value?.skipped?.length) {
          skippedReports.push(skippedEntry(r.value));
        }
      });
      await reload();
      if(viewedProfile)setProfileNodes(await listSubscriptionNodes(viewedProfile.id));
      if (skippedReports.length > 0) setSkippedReport(skippedReports);
      if (failed.length > 0) {
        setListError(failed.slice(0, 5).join("；"));
      }
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    } finally {
      setRefreshingAll(false);
    }
  }

  async function onRemove(id: string) {
    const target=items.find(item=>item.id===id);if(!target)return;
    try {
      const [status,ownedNodes]=await Promise.all([getProxyStatus(),listSubscriptionNodes(id)]);
      setDeleteTarget({...target,node_count:ownedNodes.length});
      setDeleteBlocked(status.running && (target.enabled||status.runtime_profile_id===id||ownedNodes.some(n=>n.id===(status.actual_node_id??status.current_node_id))));
    } catch(error) {setListError(String(error));}
  }

  async function confirmRemove(id:string){
    setActionId(id);
    setListError(null);
    try {
      await removeSubscription(id);
      setDeleteTarget(null);
      await reload();
    } catch (e) {
      setListError(typeof e === "string" ? e : String(e));
    } finally {
      setActionId(null);
    }
  }

  /** ⋮ → 查看配置: fetch the saved verbatim body (falls back to stored
   *  content for text/custom profiles whose raw file predates the feature). */
  async function openRawConfig(profile: SubscriptionView) {
    setRawProfile(profile);
    setRawBody(undefined);
    setRevealRaw(false);
    setRawCopied(false);
    try {
      const body = await getSubscriptionRawConfig(profile.id);
      setRawBody(body ?? null);
    } catch {
      setRawBody(null);
    }
  }

  async function copyRawBody() {
    if (!rawBody) return;
    try {
      await navigator.clipboard.writeText(rawBody);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = rawBody;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setRawCopied(true);
    window.setTimeout(() => setRawCopied(false), 1500);
  }

  /** ⋮ → 内核支持: re-parse the saved raw body and show per-core counts. */
  async function openCoreSupport(profile: SubscriptionView) {
    setSupportProfile(profile);
    setSupportReport(undefined);
    setSupportCopied(false);
    try {
      const report = await getSubscriptionCoreSupport(profile.id);
      setSupportReport(report ?? null);
    } catch {
      setSupportReport(null);
    }
  }

  /** Copyable analysis report — the format real-user feedback is made of:
   *  per-core counts, per-node exclusion reasons, parse-level drops. */
  async function copySupportReport() {
    const profile = supportProfile;
    const report = supportReport;
    if (!profile || !report) return;
    let version = "";
    try {
      version = await getVersion();
    } catch {
      version = "?";
    }
    const coreName = (k: "singbox" | "mihomo" | "xray") =>
      k === "singbox" ? t("config.typeSingbox") : k === "mihomo" ? t("config.typeMihomo") : t("config.typeXray");
    const lines: string[] = [
      `=== ${t("config.supportReportTitle")} v${version} ===`,
      `${t("config.reportProfile", { name: profile.name })}（${report.format}）`,
      `${t("config.supportTotal", { n: report.total_entries })} · ${t("config.supportRecognized", { n: report.recognized })} · ${t("config.skipped", { n: report.skipped.length })}`,
      "",
      (["singbox", "mihomo", "xray"] as const)
        .map((k) => `${coreName(k)} ${report.cores[k]}/${report.total_entries}`)
        .join(" · "),
    ];
    for (const k of ["singbox", "mihomo", "xray"] as const) {
      const items = report.unsupported[k];
      if (!items.length) continue;
      lines.push("", t("config.supportUnsupportedSection", { core: coreName(k), n: items.length }));
      items.forEach((item, i) => {
        lines.push(`  ${i + 1}. ${item.name}（${item.type_label}）— ${describeImportSkip(item.reason)} [${item.reason}]`);
      });
    }
    if (report.skipped.length > 0) {
      lines.push("", t("config.supportSkippedSection", { n: report.skipped.length }));
      report.skipped.forEach((item, i) => {
        lines.push(`  ${i + 1}. ${item.name || t("config.skippedUnnamed")} — ${describeImportSkip(item.reason)} [${item.reason}]`);
      });
    }
    const text = redactSecrets(lines.join("\n"));
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setSupportCopied(true);
    window.setTimeout(() => setSupportCopied(false), 1500);
  }

  const probeFor=(node:ProxyNode)=>profileResults.get(node.id)??node.last_probe??{
    latency_ms:node.latency_ms,tested_at:node.latency_at??0,method:node.latency_method??'',error:null,
  };
  const visibleProfileNodes=profileNodes.filter(n=>(n.name+' '+n.server+' '+n.protocol).toLowerCase().includes(profileQuery.toLowerCase())).sort((a,b)=>{
    if(profileSort==='name')return a.name.localeCompare(b.name);
    if(profileSort==='latency')return (probeFor(a).latency_ms??Infinity)-(probeFor(b).latency_ms??Infinity);
    return 0;
  });
  const browsedProfile=items.find(p=>p.id===viewedProfile?.id)??viewedProfile;

  function renderProfilePanel() {
    if(!browsedProfile)return <section className="profile-workspace-panel"><p>{t('profiles.chooseProfile')}</p></section>;
    const selectedId=profileStatus?.selected_node_id!==undefined?profileStatus.selected_node_id:profileSettings?.last_manual_node_id??profileSettings?.current_node_id;
    const actual=!selectingNode&&!coreBusy&&profileStatus?.running&&profileStatus.core_state==='running'?profileStatus.actual_node_id:null;
    return <section className="profile-browser profile-workspace-panel" aria-labelledby="profile-browser-title">
      <header className="profile-panel-header"><div><h2 id="profile-browser-title">{browsedProfile.name}</h2><small>{t('profiles.updated')}: {formatRelative(browsedProfile.last_update,t)}</small></div>
        <GlassButton disabled={busy||browsedProfile.source_kind!=='url'} onClick={()=>void onRefresh(browsedProfile.id)}>{t('common.refresh')}</GlassButton>
      </header>
      <p className="profile-chosen-summary"><strong>{t('profiles.selected')}: {profileStatus?.selected_node_name??'—'}</strong>{actual!==selectedId&&actual&&<span>{t('profiles.inUse')}: {profileStatus?.actual_node_name??'—'}</span>}</p>
      <div className="profile-selection-controls">
        <label>{t('profiles.selectionMode')}<select value={profileSettings?.auto_select??'off'} disabled={busy||runtimeSource!=='generated'} onChange={e=>void changeProfileMode(e.target.value as 'off'|'smart'|'kernel')}><option value="off">{t('profiles.manual')}</option><option value="smart">{t('profiles.smart')}</option><option value="kernel">{t('profiles.auto')}</option></select></label>
        <GlassButton disabled={busy||(!profileStatus?.running&&!profileSettings?.current_node_id)} onClick={()=>void toggleProfileConnection()}>{t(profileStatus?.running?'profiles.disconnect':'profiles.connect')}</GlassButton>
      </div>
      <p className="field-hint">{t('profiles.browseHint')}</p>{runtimeSource!=='generated'&&<p className="field-hint">{t('profiles.generatedOnly')}</p>}
      {profileSettings?.retained_node_ids?.includes(profileSettings.current_node_id??'')&&<p className="profile-warning" role="alert">{t('profiles.removedChoice')}</p>}
      <div className="profile-browser-tools"><input className="search" aria-label={t('nodes.search')} placeholder={t('nodes.search')} value={profileQuery} onChange={e=>setProfileQuery(e.target.value)}/>
        <select aria-label={t('profiles.sort')} value={profileSort} onChange={e=>setProfileSort(e.target.value)}><option value="default">{t('nodes.sortDefault')}</option><option value="name">{t('nodes.sortName')}</option><option value="latency">{t('nodes.sortLatency')}</option></select>
      </div>
      <div className="profile-browser-tools">
        <select aria-label={t('profiles.checkType')} disabled={busy} value={profileTestKind} onChange={e=>setProfileTestKind(e.target.value as 'tcp'|'proxy')}><option value="tcp">TCP</option><option value="proxy" disabled={profileSettings?.core_type==='xray'}>{t('profiles.proxyResult')}</option></select>
        <GlassButton disabled={busy||profileLoading||!visibleProfileNodes.length} onClick={()=>void checkProfileNodes(profileTestKind==='proxy',visibleProfileNodes.map(n=>n.id))}>{t('profiles.checkAll')}</GlassButton>
        {profileTesting.size>0&&<small>{[...profileTesting].filter(id=>profileResults.has(id)).length}/{profileTesting.size}</small>}
      </div>
      <p className="field-hint">{t('profiles.checkHint')}</p>
      {profileLoading?<p>{t('common.loading')}</p>:<div className="profile-browser-nodes">{visibleProfileNodes.map(n=>{
        const r=probeFor(n);const pending=profileTesting.has(n.id)&&!profileResults.has(n.id);
        const state=pending?t('nodes.testing'):!r.tested_at?t('stage3.unchecked'):r.method==='unsupported_proxy'?t('profiles.probeUnavailable'):r.method==='unsupported'?t('nodes.pingUnsupported'):r.latency_ms!=null?t('profiles.reachable'):/timeout|timed out|超时|истек|ожидан/i.test(r.error??'')?t('stage3.timeout'):r.error?t('common.error'):t('stage3.noResponse');
        const selected=selectedId===n.id;
        return <div className={`profile-browser-node${selected?' is-selected':''}${actual===n.id?' is-active':''}`} key={n.id}>
          <div className="profile-node-name"><strong title={n.name}>{n.name}</strong><small>{n.protocol.toUpperCase()} · {n.server}:{n.port}</small><span>{selected&&<i>{t('profiles.selected')}</i>}{actual===n.id&&actual!==selectedId&&<i>{t('profiles.inUse')}</i>}{n.retained&&<i className="profile-warning">{t('profiles.removed')}</i>}</span></div>
          <div className="profile-node-measure" title={redactSecrets(explainOperationError(r.error??''))}><strong>{pending?'…':r.latency_ms!=null?`${r.latency_ms} ${t('stage3.ms')}`:'—'}</strong><small>{state}</small>{r.tested_at>0&&<small>{r.method==='tcp'||r.method==='unsupported'?'TCP':t('profiles.proxyResult')} · {formatRelative(r.tested_at,t)}</small>}</div>
          <div className="profile-browser-node-actions"><GlassButton disabled={busy} onClick={()=>void checkProfileNodes(profileTestKind==='proxy',[n.id])}>{t('profiles.check')}</GlassButton><GlassButton disabled={busy||runtimeSource!=='generated'||(selected&&profileSettings?.auto_select==='off'&&(!profileStatus?.running||actual===n.id))} onClick={()=>void pickProfileNode(n.id)}>{t('profiles.select')}</GlassButton>
            <details className="profile-node-menu"><summary aria-label={t('profiles.more')}>⋯</summary><button disabled={busy} onClick={()=>{void toggleFavoriteNode(n.id).then(favorite=>setProfileNodes(previous=>previous.map(x=>x.id===n.id?{...x,favorite}:x))).catch(error=>setProfileError(String(error)));}}>{t(n.favorite?'profiles.unfavorite':'profiles.favorite')}</button></details>
          </div>
        </div>;
      })}{!visibleProfileNodes.length&&<p>{t('profiles.noMatches')}</p>}</div>}
      {(profileError||profileStatus?.error)&&<p role="alert">{redactSecrets(explainOperationError(profileError??profileStatus?.error??''))}</p>}
      {mixMode&&runtimeSource==='generated'&&<GlassButton disabled={busy||(browsedProfile.enabled&&profileNodes.some(n=>n.id===profileSettings?.current_node_id))} onClick={()=>void onActivate(browsedProfile.id)}>{t(browsedProfile.enabled?'profiles.disable':'profiles.enable')}</GlassButton>}
    </section>;
  }

  function renderCard(item: SubscriptionView) {
    const generated = item.source_kind !== "custom";
    // Custom mode: switching the active profile is a runtime-source change
    // (homepage picker) — subscription / local cards become read-only.
    const clickable = generated;
    const customActive =
      !generated && runtimeSource === `singbox:${item.id}`;
    const generatedActive = generated && runtimeSource === "generated" && item.enabled;
    const typeTag = typeTagLabel(t, item);
    return (
      <article
        key={item.id}
        data-profile-id={item.id}
        className={`sub-card${viewedProfile?.id===item.id?" is-browsed":""}${generatedActive || customActive ? " enabled" : ""}${
          clickable ? "" : " readonly"
        }`}
        role={clickable ? "button" : "article"}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => {if(!busy){if(managementOnly)onSourceSelected?.(item.id);else setViewedProfile(item);}} : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if(!busy){if(managementOnly)onSourceSelected?.(item.id);else setViewedProfile(item);}
                }
              }
            : undefined
        }
      >
        <div className="sub-card-main">
          <div className="sub-card-top">
            {generated ? (
              <span
                className="node-dot"
                aria-label={
                  item.enabled ? t("common.enabled") : t("common.disabled")
                }
              >
                {item.enabled ? "●" : "○"}
              </span>
            ) : null}
            <h3 title={item.name}>{item.name}</h3>
            <div className="sub-card-top-right">
              <span className="sub-card-updated muted">
                {formatRelative(item.last_update, t)}
              </span>
              <div
                className="sub-menu"
                data-sub-menu
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="sub-menu-trigger"
                  aria-label={t("common.actions")}
                  aria-haspopup="menu"
                  aria-expanded={menuId === item.id}
                  disabled={busy && menuId !== item.id}
                  onClick={() =>
                    setMenuId((id) => (id === item.id ? null : item.id))
                  }
                >
                  {actionId === item.id ||
                  (refreshingAll && menuId === item.id)
                    ? "…"
                    : "⋮"}
                </button>
                {menuId === item.id && (
                  <div className="sub-menu-pop" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="sub-menu-item"
                      disabled={busy}
                      onClick={() => {
                        setMenuId(null);
                        void openEdit(item.id);
                      }}
                    >
                      {t("config.menuEdit")}
                    </button>
                    {item.source_kind === "url" && (
                      <button
                        type="button"
                        role="menuitem"
                        className="sub-menu-item"
                        disabled={busy}
                        onClick={() => {
                          setMenuId(null);
                          void onRefresh(item.id);
                        }}
                      >
                        {t("config.menuUpdate")}
                      </button>
                    )}
                    {item.source_kind !== "node" && (
                      <button
                        type="button"
                        role="menuitem"
                        className="sub-menu-item"
                        disabled={busy}
                        onClick={() => {
                          setMenuId(null);
                          void openRawConfig(item);
                        }}
                      >
                        {t("config.menuViewConfig")}
                      </button>
                    )}
                    {item.source_kind !== "node" && (
                      <button
                        type="button"
                        role="menuitem"
                        className="sub-menu-item"
                        disabled={busy}
                        onClick={() => {
                          setMenuId(null);
                          void openCoreSupport(item);
                        }}
                      >
                        {t("config.menuSupport")}
                      </button>
                    )}
                    {item.source_kind !== "url" &&
                      item.source_kind !== "custom" && (
                        <button
                          type="button"
                          role="menuitem"
                          className="sub-menu-item"
                          disabled={busy}
                          onClick={() => {
                            setMenuId(null);
                            setRenameProfile(item);
                          }}
                        >
                          {t("config.menuRenameNodes")}
                        </button>
                      )}
                    <button
                      type="button"
                      role="menuitem"
                      className="sub-menu-item danger"
                      data-testid="source-delete"
                      disabled={busy}
                      onClick={() => {
                        setMenuId(null);
                        void onRemove(item.id);
                      }}
                    >
                      🗑 {t("sources.delete")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="sub-card-meta">
            {generated ? (
              <span>{t("config.nodes", { n: item.node_count })}</span>
            ) : (
              <span>{t("config.customReadonly")}</span>
            )}
            {item.skipped_count > 0 && (
              <span className="warn">
                {t("config.skipped", { n: item.skipped_count })}
              </span>
            )}
            {typeTag && <span className="sub-type-tag">{typeTag}</span>}
          </div>
          <TrafficBlock traffic={item.traffic} />
          {managementOnly&&mixMode&&generated&&<GlassButton disabled={busy||(profileStatus?.running&&item.enabled&&(!profileStatus.runtime_profile_id||item.id===profileStatus.runtime_profile_id))} onKeyDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();void onActivate(item.id)}}>{t(item.enabled?'profiles.disable':'profiles.enable')}</GlassButton>}
        </div>
      </article>
    );
  }

  return (
    <div className={`page config-page${managementOnly ? " source-management" : ""}`}>
      <header className="page-header">
        <div>
          <h1>{t(managementOnly ? "sources.manage" : "config.title")}</h1>
          <p className="page-desc">{t("config.desc")}</p>
        </div>
        <div className="header-actions">
          <GlassSwitch
            checked={mixMode}
            ready={!loading}
            onChange={() => void onToggleMix()}
            label={t("config.mix")}
            title={mixMode ? t("config.mixEnabled") : t("config.mixDisabled")}
            disabled={loading || busy || runtimeSource.startsWith("singbox:")}
            capsule
            size="sm"
          />
          <GlassButton
            icon="↻"
            disabled={busy || items.every((item) => item.source_kind !== "url")}
            onClick={() => void onRefreshAll()}
          >
            {refreshingAll ? t("config.refreshing") : t("config.refreshAll")}
          </GlassButton>
          <GlassButton icon="+" disabled={busy} onClick={openAdd}>
            {t("config.add")}
          </GlassButton>
        </div>
      </header>

      {listError && (
        <ErrorModal
          message={listError}
          onClose={() => setListError(null)}
        />
      )}

      {skippedReport && (
        <div className="modal-backdrop">
          <div className="modal skipped-nodes-modal">
            <header className="modal-header">
              <h2>
                {t("importReport.skipped", {
                  n: skippedReport.reduce((sum, r) => sum + r.skipped.length, 0),
                })}
              </h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSkippedReport(null)}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {t("importReport.hint")}
              </p>
              {skippedReport.map((r) => (
                <div key={r.name + r.source} className="skipped-report-block">
                  <div className="skipped-report-sub">
                    <strong>{r.name}</strong><span>{t("importReport.accepted",{n:r.imported})} · {t("importReport.service",{n:r.skipped.filter(item=>isServiceEntry(item.reason)).length})}</span>
                    {r.format ? <span className="muted mono">{r.format}</span> : null}
                    <span className="muted skipped-report-source">{r.source}</span>
                  </div>
                  <ul className="skipped-report-list">
                    {r.skipped.map((item, i) => (
                      <li key={i} title={`${item.reason}`}>
                        <span className="skipped-item-name">{item.name || t("config.skippedUnnamed")}</span>
                        <span className="muted skipped-item-reason">{describeImportSkip(item.reason)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <footer className="modal-footer">
              <GlassButton onClick={() => setSkippedReport(null)}>
                {t("common.close")}
              </GlassButton>
              <GlassButton variant="primary" onClick={() => void copySkippedReport()}>
                {skippedCopied ? t("common.copied") : t("config.skippedCopy")}
              </GlassButton>
            </footer>
          </div>
        </div>
      )}

      <div className={managementOnly ? "source-management-list" : "profile-workspace"}><aside className="profile-workspace-list">
      {loading ? (
        <div className="empty">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="empty card">
          <p>{t("config.empty")}</p>
          <p className="muted">{t("config.emptyHint")}</p>
          <GlassButton variant="primary" icon="+" onClick={openAdd}>
            {t("config.add")}
          </GlassButton>
        </div>
      ) : (
        <div className="config-groups">
          <ConfigGroup hideEmpty
            title={t("config.groupSubscription")}
            empty={t("config.groupSubscriptionEmpty")}
            items={items.filter((item) => item.source_kind === "url")}
            renderCard={(item) => renderCard(item)}
          />
          <ConfigGroup hideEmpty
            title={t("config.groupLocal")}
            empty={t("config.groupLocalEmpty")}
            items={items.filter(
              (item) =>
                item.source_kind !== "url" && item.source_kind !== "custom",
            )}
            renderCard={(item) => renderCard(item)}
          />
          <ConfigGroup hideEmpty
            title={t("config.groupCustom")}
            empty={t("config.groupCustomEmpty")}
            items={items.filter((item) => item.source_kind === "custom")}
            renderCard={(item) => renderCard(item)}
          />
        </div>
      )}

      </aside>{!managementOnly && renderProfilePanel()}</div>

      {deleteTarget && <div className="modal-backdrop"><section className="modal source-delete-confirm" data-testid="source-delete-confirm" role="dialog" aria-modal="true" aria-label={t('sources.delete')}>
        <header className="modal-header"><h2>{t('sources.delete')}</h2></header><div className="modal-body"><p>{t('sources.confirmDelete',{name:deleteTarget.name,n:deleteTarget.node_count})}</p>
        {deleteBlocked && <p role="status">{t('sources.stopFirst')}</p>}</div><footer className="modal-footer"><GlassButton disabled={busy} onClick={()=>setDeleteTarget(null)}>{t('common.cancel')}</GlassButton>
        {deleteBlocked ? <GlassButton disabled={busy} onClick={async()=>{try{await stopProxy();setDeleteBlocked(false);await reload()}catch(e){setListError(String(e))}}}>{t('profiles.disconnect')}</GlassButton> : <GlassButton variant="danger" disabled={busy} onClick={()=>void confirmRemove(deleteTarget.id)}>{t('sources.delete')}</GlassButton>}
        </footer></section></div>}
      <AddConfigModal
        open={modalOpen}
        busy={importing}
        error={importError}
        onDismissError={() => setImportError(null)}
        isEdit={!!editId}
        initial={editInitial}
        existingUrls={existingUrls
          .filter((item) => item.id !== editId)
          .map((item) => item.url)}
        onClose={() => {
          if (importing) return;
          setModalOpen(false);
          setEditId(null);
          setEditInitial(null);
          dismiss();
        }}
        onSubmit={(p) => void handleSubmit(p)}
      />
      {rawProfile && (
        <div className="modal-backdrop">
          <div className="modal raw-config-modal">
            <header className="modal-header">
              <h2>
                {t("config.rawTitle")}
                {rawProfile.name ? ` · ${rawProfile.name}` : ""}
                {typeTagLabel(t, rawProfile) && (
                  <span className="sub-type-tag">
                    {typeTagLabel(t, rawProfile)}
                  </span>
                )}
              </h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setRawProfile(null)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              {rawBody === undefined ? (
                <div className="empty">{t("common.loading")}</div>
              ) : rawBody === null ? (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {t("config.rawNone")}
                </p>
              ) : (
                <><p className="field-hint">{t("stage3.secrets")}</p><GlassButton onClick={()=>setRevealRaw(!revealRaw)}>{t(revealRaw?"stage3.hide":"stage3.reveal")}</GlassButton><pre className="raw-config-pre">{revealRaw ? rawBody : redactSecrets(rawBody)}</pre></>
              )}
            </div>
            <footer className="modal-footer">
              <GlassButton onClick={() => setRawProfile(null)}>
                {t("common.close")}
              </GlassButton>
              <GlassButton
                variant="primary"
                disabled={!rawBody}
                onClick={() => void copyRawBody()}
              >
                {rawCopied ? t("common.copied") : t("config.rawCopy")}
              </GlassButton>
            </footer>
          </div>
        </div>
      )}

      {supportProfile && (
        <div className="modal-backdrop">
          <div className="modal support-modal">
            <header className="modal-header">
              <h2>
                {t("config.supportTitle")}
                {supportProfile.name ? ` · ${supportProfile.name}` : ""}
              </h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSupportProfile(null)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              {supportReport === undefined ? (
                <div className="empty">{t("common.loading")}</div>
              ) : supportReport === null ? (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {t("config.rawNone")}
                </p>
              ) : (
                <>
                  <div className="support-summary">
                    <span className="sub-type-tag">{supportReport.format}</span>
                    <span className="muted">
                      {t("config.supportTotal", { n: supportReport.total_entries })}
                    </span>
                    <span className="muted">
                      {t("config.supportRecognized", { n: supportReport.recognized })}
                    </span>
                    {supportReport.skipped.length > 0 && (
                      <span className="warn">
                        {t("config.skipped", { n: supportReport.skipped.length })}
                      </span>
                    )}
                  </div>
                  {(
                    [
                      ["sing-box", supportReport.cores.singbox],
                      ["mihomo", supportReport.cores.mihomo],
                      ["Xray", supportReport.cores.xray],
                    ] as const
                  ).map(([label, count]) => {
                    const total = Math.max(supportReport.total_entries, 1);
                    const pct = Math.round((count / total) * 100);
                    return (
                      <div className="support-row" key={label}>
                        <span className="support-row-label">{label}</span>
                        <div className="support-bar" role="progressbar" aria-label={label}>
                          <div className="support-bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="support-row-count">
                          {count} / {supportReport.total_entries}
                        </span>
                      </div>
                    );
                  })}
                  {(
                    [
                      ["singbox", supportReport.unsupported.singbox],
                      ["mihomo", supportReport.unsupported.mihomo],
                      ["xray", supportReport.unsupported.xray],
                    ] as const
                  ).map(([core, items]) =>
                    items.length === 0 ? null : (
                      <div className="support-skipped" key={core}>
                        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                          {t("config.supportUnsupportedSection", {
                            core:
                              core === "singbox"
                                ? t("config.typeSingbox")
                                : core === "mihomo"
                                  ? t("config.typeMihomo")
                                  : t("config.typeXray"),
                            n: items.length,
                          })}
                        </p>
                        <ul className="skipped-report-list">
                          {items.map((item, i) => (
                            <li key={i} title={item.reason}>
                              <span className="skipped-item-name">{item.name}</span>
                              <span className="muted skipped-item-type">{item.type_label}</span>
                              <span className="muted skipped-item-reason">{describeImportSkip(item.reason)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ),
                  )}
                  <div className="support-skipped">
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      {supportReport.skipped.length > 0
                        ? t("config.supportSkippedSection", { n: supportReport.skipped.length })
                        : t("config.supportSkippedNone")}
                    </p>
                    {supportReport.skipped.length > 0 && (
                      <ul className="skipped-report-list">
                        {supportReport.skipped.map((item, i) => (
                          <li key={i} title={item.reason}>
                            <span className="skipped-item-name">
                              {item.name || t("config.skippedUnnamed")}
                            </span>
                            <span className="muted skipped-item-reason">{describeImportSkip(item.reason)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
            <footer className="modal-footer">
              <GlassButton onClick={() => setSupportProfile(null)}>
                {t("common.close")}
              </GlassButton>
              <GlassButton
                variant="primary"
                disabled={!supportReport}
                onClick={() => void copySupportReport()}
              >
                {supportCopied ? t("common.copied") : t("config.supportCopyReport")}
              </GlassButton>
            </footer>
          </div>
        </div>
      )}

      <EditLocalNodesModal
        open={!!renameProfile}
        profileId={renameProfile?.id ?? null}
        profileName={renameProfile?.name ?? ""}
        onClose={() => setRenameProfile(null)}
      />
    </div>
  );
}
