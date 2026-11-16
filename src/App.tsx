import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { refreshProxyStatus } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorModal } from "./components/ErrorModal";
import { beginCoreBusy } from "./coreBusy";
import { ImportIntentProvider } from "./ImportIntentContext";
import { LocaleProvider, useI18n } from "./i18n";
import { ThemeProvider } from "./theme";
import { UiModeProvider } from "./ui/UiModeContext";
import "./quiet-control/upstream.css";
import { QuietControlShell } from "./quiet-control/Shell";

function AppShell() {
  const { t } = useI18n();
  const [applyError, setApplyError] = useState<string | null>(null);

  // The watchdog announces core lifecycle edges (unexpected exit, auto
  // revival, restarts). Polling alone leaves pages stale while hidden or
  // while the runtime lock is busy — resync the shared snapshot the moment
  // the backend announces a change; subscribed pages re-render from it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("core-status-changed", () => {
      void refreshProxyStatus();
    }).then((dispose) => {
      if (disposed) dispose(); else unlisten = dispose;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Background rule/config apply restarts the core outside invoke wrappers —
  // keep the navbar spinner in sync via the apply-status event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let endBusy: (() => Promise<void>) | undefined;
    let disposed = false;
    void listen<{
      status: "restarting" | "ready" | "error";
      error?: string | null;
    }>("config-apply-status", (event) => {
      const status = event.payload.status;
      if (status === "restarting") {
        if (!endBusy) endBusy = beginCoreBusy();
      } else {
        void endBusy?.();
        endBusy = undefined;
        if (status === "error") {
          setApplyError(event.payload.error || t("config.applyFailed"));
        } else {
          setApplyError(null);
        }
      }
    }).then((dispose) => {
      if (disposed) dispose(); else unlisten = dispose;
    });
    return () => {
      disposed = true;
      void endBusy?.();
      unlisten?.();
    };
  }, [t]);

  // Paint immediately from localStorage mode (Rust already sized window on recreate).
  return (
    <>
      {applyError && (
        <ErrorModal
          message={applyError}
          onClose={() => setApplyError(null)}
        />
      )}
      {/* Crash net: any render exception below would otherwise blank the
         whole window; the boundary reports it to the app log and offers a
         remount. Providers sit above it — a crash inside those still blanks
         (they run before this boundary mounts), but page/shell crashes are
         the realistic class and are fully covered. */}
      <ErrorBoundary>
        <QuietControlShell/>
      </ErrorBoundary>
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <UiModeProvider externalLayout>
          <ImportIntentProvider>
            <AppShell />
          </ImportIntentProvider>
        </UiModeProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}

export default App;
