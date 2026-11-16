import { q } from "../i18n";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getSettings, updateSettings } from "../api";
import { useTheme, applyThemeToDom } from "../theme/ThemeContext";

export type ThemePreference = "dark" | "light" | "system";
const KEY = "quiet-control.theme";
const Context = createContext<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void; saveError: string | null }>({ preference: "system", setPreference: () => {}, saveError: null });
export function QuietTheme({ children }: { children: ReactNode }) {
  const legacy = useTheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    try { const stored = localStorage.getItem(KEY); if (stored === "dark" || stored === "light") return stored; } catch { /* storage unavailable */ }
    return "system";
  });
  const revision = useRef(0);
  const mounted = useRef(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const initialRevision = revision.current;
    void getSettings().then(settings => {
      if (active && revision.current === initialRevision && settings.quiet_theme) setPreferenceState(settings.quiet_theme);
    }).catch(error => { if (active) setSaveError(q("qc.105", {v0: String(error)})); })
      .finally(() => { if (active) setHydrated(true); });
    return () => { active = false; mounted.current = false; };
  }, []);
  function setPreference(next: ThemePreference) {
    const current = ++revision.current;
    setPreferenceState(next);
    setSaveError(null);
    void updateSettings({ quietTheme: next }).catch(error => {
      if (mounted.current && revision.current === current) setSaveError(q("qc.106", {v0: String(error)}));
    });
  }
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    changed(); media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => {
    const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
    document.documentElement.dataset.qcTheme = resolved;
    // Keep upstream pages and body-level portals on the same resolved theme.
    applyThemeToDom(resolved === "dark" ? "aerospace" : "day", legacy.accent, legacy.glow);
    const nativeTheme = resolved === "dark" ? "aerospace" : "day";
    if (hydrated && legacy.ready && legacy.theme !== nativeTheme) void legacy.setTheme(nativeTheme);
    try { localStorage.setItem(KEY, preference); } catch { /* the theme still works in memory */ }
  }, [preference, systemDark, hydrated, legacy.ready, legacy.theme, legacy.accent, legacy.glow, legacy.setTheme]);
  return <Context.Provider value={{ preference, setPreference, saveError }}>{children}</Context.Provider>;
}
export const useQuietTheme = () => useContext(Context);
