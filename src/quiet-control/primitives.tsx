import { redactSecrets } from "./privacy";
import { q } from "../i18n";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

const paths: Record<string, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
  profiles: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h4"/></>,
  nodes: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M16 7h2M16 17h2"/></>,
  routes: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h9a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8M19 16v-5"/></>,
  dns: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  traffic: <><path d="M4 19V5M4 19h17M7 14l4-5 4 3 5-7"/></>,
  tools: <><path d="m14 6 4 4-9 10H4v-5Z"/><path d="M14 6V3l4 1 3 3-1 4h-3"/></>,
  settings: <><path d="m9 3-1 3-3 1v4l2 1-2 3 2 3 3-1 2 4 3-1 1-3 4-1v-4l-3-1 1-4-3-2-3 2Z"/><circle cx="12" cy="12" r="3"/></>,
  logs: <><path d="M6 3h12v18H6ZM9 7h6M9 11h6M9 15h3"/></>,
  power: <><path d="M12 3v9M6 6a8 8 0 1 0 12 0"/></>,
  arrow: <path d="m9 5 7 7-7 7"/>,
  down: <path d="M12 3v18m-6-6 6 6 6-6"/>,
  up: <path d="M12 21V3m-6 6 6-6 6 6"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 14-2M19 16a8 8 0 0 1-14 2"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.info}</svg>;
}
export function Button({ children, variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <button type="button" className={`qc-button qc-${variant} ${className}`} {...props}>{children}</button>;
}
export function IconButton({ label, icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: string }) {
  return <Button {...props} className="qc-icon-button" aria-label={label} title={label}><Icon name={icon}/></Button>;
}
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span className="qc-tooltip" data-tip={label}>{children}</span>;
}
export function Card({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`qc-card ${className}`} aria-label={title}><header className="qc-card-head"><h2>{title}</h2>{action}</header>{children}</section>;
}
export function StatusIndicator({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={`qc-status qc-tone-${tone}`}><i/>{children}</span>;
}
export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <label className="qc-field"><span>{label}</span><select {...props}>{children}</select></label>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="qc-empty"><span className="qc-empty-icon"><Icon name="nodes" size={24}/></span><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="qc-error" role="alert"><Icon name="info"/><span>{q("stage3.errorHelp")}<details><summary>{q("stage3.details")}</summary><pre>{redactSecrets(message)}</pre></details></span>{onRetry && <Button onClick={onRetry}>{q("qc.104")}</Button>}</div>;
}
export function Skeleton() {
  return <div className="qc-skeleton" role="status" aria-label={q("qc.063")}><span/><span/><span/></div>;
}
/** Native dialog provides focus containment, Esc and focus restoration. */
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="qc-dialog" onCancel={onClose} aria-labelledby="qc-dialog-title"><h2 id="qc-dialog-title">{title}</h2>{children}<Button onClick={onClose}>{q("qc.026")}</Button></dialog>;
}
export function DataRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="qc-data-row"><dt>{label}</dt><dd>{children}</dd></div>;
}
