import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyWindowSizeForUiMode,
  persistUiModePref,
  watchWindowSize,
} from "./windowLayout";

export type UiMode = "pro" | "simple";

const STORAGE_KEY = "satelite.uiMode";

function readStored(): UiMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)?.trim().toLowerCase();
    if (v === "simple" || v === "pro") return v;
  } catch {
    /* ignore */
  }
  return "pro";
}

interface UiModeContextValue {
  mode: UiMode;
  /**
   * Always true: shell paints from localStorage immediately.
   * Window resize / persist run in the background (Rust already sizes on WebView recreate).
   */
  layoutReady: boolean;
  setMode: (mode: UiMode) => void;
  toggleMode: () => void;
}

const UiModeContext = createContext<UiModeContextValue | null>(null);

export function UiModeProvider({ children, externalLayout = false }: { children: ReactNode; externalLayout?: boolean }) {
  const [mode, setModeState] = useState<UiMode>(() => readStored());
  const layoutReady = true;

  // Background sync only — never block first paint (low-memory wake path).
  useEffect(() => {
    if (externalLayout) return;
    const initial = readStored();
    setModeState(initial);
    try {
      document.documentElement.dataset.uiMode = initial;
    } catch {
      /* ignore */
    }
    void persistUiModePref(initial);
    void applyWindowSizeForUiMode(initial);
  }, [externalLayout]);

  // Remember the user-resized window size per mode while it is active.
  useEffect(() => externalLayout ? undefined : watchWindowSize(mode), [mode, externalLayout]);

  const setMode = useCallback((next: UiMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.dataset.uiMode = next;
    } catch {
      /* ignore */
    }
    // Resize first, then swap shell — avoids full-width simple / narrow pro frames.
    void (async () => {
      await persistUiModePref(next);
      if (!externalLayout) await applyWindowSizeForUiMode(next);
      setModeState(next);
    })();
  }, [externalLayout]);

  const toggleMode = useCallback(() => {
    setMode(mode === "pro" ? "simple" : "pro");
  }, [mode, setMode]);

  const value = useMemo(
    () => ({ mode, layoutReady, setMode, toggleMode }),
    [mode, layoutReady, setMode, toggleMode],
  );

  return (
    <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>
  );
}

export function useUiMode(): UiModeContextValue {
  const ctx = useContext(UiModeContext);
  if (!ctx) {
    throw new Error("useUiMode must be used within UiModeProvider");
  }
  return ctx;
}
