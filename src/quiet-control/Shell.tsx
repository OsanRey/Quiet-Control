import { q, useI18n } from "../i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { useImportIntent } from "../ImportIntentContext";
import { CoreDownloadToast } from "../components/CoreDownloadToast";
import { useControlData, diagnoseNetwork } from "./data";
import { type Page } from "./Dashboard";
import { QuietTheme, useQuietTheme } from "./Theme";
import { Button, Card, ErrorState, Icon, Skeleton } from "./primitives";
import { Chrome, Home } from "./v2/Interface";
import "./quiet-control.css";

const RoutingPage = lazy(() => import("./routing/RoutingPage").then(m => ({default:m.RoutingPage})));
const NodesPage = lazy(() => import("../pages/NodesPage").then(m => ({ default: m.NodesPage })));
const TrafficPage = lazy(() => import("../pages/TrafficPage").then(m => ({ default: m.TrafficPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const LogsPage = lazy(() => import("../pages/LogsPage").then(m => ({ default: m.LogsPage })));
const LegacyDashboard = lazy(() => import("../pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const sections: { id: Page; label: string; icon: string }[] = [
  { id: "home", label: q("qc.001"), icon: "home" },
  { id: "nodes", label: q("qc.003"), icon: "nodes" }, { id: "routes", label: q("qc.004"), icon: "routes" },
  { id: "dns", label: "DNS", icon: "dns" }, { id: "traffic", label: q("qc.005"), icon: "traffic" },
  { id: "tools", label: q("qc.006"), icon: "tools" }, { id: "logs", label: q("qc.007"), icon: "logs" },
  { id: "settings", label: q("qc.008"), icon: "settings" },
];

function Tools({ navigate }: { navigate: (page: Page) => void }) {
  const [result, setResult] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function diagnose() {
    setBusy(true); setError(null);
    try { const report = await diagnoseNetwork(); setResult(report.issues.map(i => `${i.issue} — ${i.suggestion}`)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <><header className="qc-page-heading"><div><h1>{q("qc.006")}</h1><p>{q("qc.013")}</p></div></header><div className="qc-tools-grid"><Card title={q("qc.014")}><p className="qc-description">{q("qc.015")}</p><Button onClick={diagnose} disabled={busy}>{busy ? q("qc.016") : q("qc.017")}</Button>{error && <ErrorState message={error}/>} {result && (result.length ? <ul>{result.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p role="status">{q("qc.018")}</p>)}</Card><Card title={q("qc.019")}><p className="qc-description">{q("qc.020")}</p><Button onClick={() => navigate("advanced")}>{q("qc.021")}<Icon name="arrow" size={16}/></Button></Card><Card title={q("qc.022")}><p className="qc-description">{q("qc.023")}</p><Button onClick={() => navigate("logs")}>{q("qc.024")}<Icon name="arrow" size={16}/></Button></Card></div></>;
}
function Shell() {
  useI18n();
  const [page, setPage] = useState<Page>("home");
  const [manageSources,setManageSources]=useState(0);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);
  const { prefill, token } = useImportIntent();
  const data = useControlData(page === "home");
  const theme = useQuietTheme();
  // Retain old entry points (home, deep links, legacy dashboard) as aliases.
  const navigate = (next: Page) => { setManageSources(previous=>next==='profiles'?previous+1:0);setPage(next==='profiles'?'nodes':next); main.current?.scrollTo(0, 0); };
  useEffect(()=>{const open=()=>setPage("routes");window.addEventListener("qc-routing-open",open);return()=>window.removeEventListener("qc-routing-open",open)},[]);
  useEffect(() => { if (prefill) {setManageSources(previous=>previous+1);setPage('nodes');} }, [prefill, token]);
  useEffect(() => {
    // Retain native Windows caption buttons, snap layouts and close-to-tray semantics.
    void getCurrentWindow().setMinSize(new LogicalSize(480, 480)).catch(e => setLayoutError(String(e)));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || (event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]")) return;
      const target = event.key === "," ? "settings" : sections[Number(event.key) - 1]?.id;
      if (target) { event.preventDefault(); setPage(target); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const legacy = page !== "home" && page !== "tools" && page !== "routes";
  return <Chrome data={data} page={page} navigate={navigate} mainRef={main}>
      {theme.saveError && <ErrorState message={theme.saveError} onRetry={() => theme.setPreference(theme.preference)}/>}
      {(data.error || layoutError) && <ErrorState message={data.error ?? layoutError!} onRetry={() => void data.refresh()}/>}
      {data.notice && <div className="qc-notice" role="status"><Icon name="check" size={17}/><span>{data.notice}</span><Button variant="ghost" onClick={data.clearNotice} aria-label={q("qc.025")}>{q("qc.026")}</Button></div>}
      <Suspense fallback={<Skeleton/>}>
        {page === "home" && <Home data={data} navigate={navigate}/>}
        {page === "tools" && <Tools navigate={navigate}/>}
        {page === "routes" && <RoutingPage advanced={() => navigate("settings")}/>}
        {legacy && <div className="qc-legacy qc-workspace" key={page}>

          {page === "nodes" && <NodesPage manageSourcesInitially={manageSources}/>}{page === "traffic" && <TrafficPage/>}{page === "logs" && <LogsPage/>}
          {(page === "settings" || page === "dns") && <SettingsPage initialTab={page === "dns" ? "dns" : "app"}/>}
          {page === "advanced" && <><Button onClick={() => navigate("home")}>{q("qc.029")}</Button><LegacyDashboard quiet onGoProfiles={() => navigate("profiles")} onGoNodes={() => navigate("nodes")} onGoTraffic={() => navigate("traffic")} onGoSettings={() => navigate("settings")}/></>}
        </div>}
      </Suspense>
    <CoreDownloadToast/>
  </Chrome>;
}
export function QuietControlShell() { return <QuietTheme><Shell/></QuietTheme>; }
import "./v2/workspace.css";
