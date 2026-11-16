import { useEffect, useRef, useState } from "react";
import "./subscription-compat.css";
import { checkSubscription } from "../api";
import { useI18n } from "../i18n";
import type { SubscriptionClient, SubscriptionHttp, SubscriptionCheck } from "../types";

export const defaultSubscriptionHttp = (): SubscriptionHttp => ({ client: "auto", send_device_id: false });
export function SubscriptionCompatibility({ value, onChange, url, viaProxy, userAgent, setUserAgent, busy, onChecking }: {
  value: SubscriptionHttp; onChange: (v: SubscriptionHttp) => void; url: string; viaProxy: boolean;
  userAgent: string; setUserAgent: (v: string) => void; busy: boolean; onChecking: (v: boolean) => void;
}) {
  const { locale } = useI18n(); const ru = locale === "ru";
  const q = (r: string, e: string) => ru ? r : e;
  const modes: [SubscriptionClient, string][] = [["auto", q("Автоматически", "Automatic")], ["happ", "Happ"], ["v2ray_tun", "v2RayTun"], ["mihomo", "Clash / Mihomo"], ["singbox", "sing-box"], ["custom", q("Пользовательский User-Agent", "Custom User-Agent")]];
  const label = (mode: SubscriptionClient) => modes.find(([id]) => id === mode)?.[1] ?? mode;
  const [report, setReport] = useState<SubscriptionCheck | null>(null);
  const [checking, setChecking] = useState(false); const generation = useRef(0);
  const key = JSON.stringify([url, viaProxy, userAgent, value]);
  useEffect(() => { generation.current++; setReport(null); }, [key]);
  useEffect(() => () => { generation.current++; onChecking(false); }, []);
  const reason = (code: string) => ({
    usable_with_exclusions: q("Пригодна: служебные и некорректные записи пропущены", "Ready: unusable entries excluded"),
    usable: q("Пригодна для импорта", "Ready to import"), placeholder: q("Информационная заглушка", "Informational placeholder"),
    suspicious_endpoint: q("Подозрительный адрес — данные сохранены", "Suspicious endpoint — cache preserved"),
    html: q("HTML вместо подписки", "HTML instead of subscription"), invalid_format: q("Формат не распознан", "Unrecognized format"),
    device_required: q("Провайдер требует идентификатор устройства", "Provider requires a device ID"),
    device_limit: q("Лимит устройств — обратитесь к провайдеру", "Device limit — contact your provider"),
    permission_denied: q("Нет разрешения — проверьте доступ у провайдера", "Permission denied — contact your provider"),
    retry_after: q("Провайдер просит подождать", "Provider requests a delay"),
    network_error: q("Ошибка сети или проверки TLS", "Network or TLS validation error"),
    time_budget: q("Истекло время проверки", "Check timed out"),
    unsupported_nodes: q("Нет узлов, поддерживаемых установленными ядрами", "No nodes supported by installed cores"),
  }[code] ?? q("Проверка не пройдена", "Check failed"));
  async function check() {
    const current = generation.current; setChecking(true); onChecking(true); setReport(null);
    try {
      const next = await checkSubscription(url.trim(), viaProxy, userAgent, value);
      if (generation.current === current) setReport(next);
    } catch {
      if (generation.current === current) setReport({ usable: false, attempts: [{ client: value.client, result: "network_error", recognized: 0, skipped: 0, supported: [0, 0, 0] }] });
    } finally { setChecking(false); onChecking(false); }
  }
  return <div className="subscription-compat">
    <label className="field"><span>{q("Совместимость клиента", "Client compatibility")}</span>
      <select value={value.client} disabled={busy || checking} onChange={e => {
        const client = e.target.value as SubscriptionClient;
        onChange({ ...value, client }); if (client !== "custom") setUserAgent("");
      }}>{modes.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select>
    </label>
    <button type="button" className="secondary" disabled={busy || checking || !url.trim()} onClick={() => void check()}>
      {checking ? q("Проверка…", "Checking…") : q("Проверить подписку", "Check subscription")}
    </button>
    <p className="hint">{q("Загрузка и проверка без сохранения и изменения подключения.", "Fetch and validate without saving or changing the connection.")}</p>
    {report && <div className="subscription-check" role="status" data-testid="subscription-check-result">
      <strong>{report.usable ? q("Подписка проверена", "Subscription verified") : q("Подписка не принята. Сохранённые узлы не изменены.", "Subscription rejected. Cached nodes unchanged.")}</strong>
      {report.attempts[report.attempts.length - 1] && <p>{reason(report.attempts[report.attempts.length - 1]!.result)} · {report.attempts[report.attempts.length - 1]!.format ?? "—"} · {q("Пригодных узлов", "Usable nodes")}: {report.attempts[report.attempts.length - 1]!.accepted ?? report.attempts[report.attempts.length - 1]!.recognized} · {q("Пропущено", "Skipped")}: {report.attempts[report.attempts.length - 1]!.skipped}</p>}
      {report.successful_client && <p>{q("Использован режим", "Used mode")}: {label(report.successful_client)}</p>}
      {!!report.retry_after_seconds && <p>{q("Повторить не раньше чем через", "Retry after")} {report.retry_after_seconds} {q("с", "s")}</p>}
      {report.successful_client && value.client === "auto" && report.successful_client !== "auto" && <button className="secondary" type="button" onClick={() => onChange({ ...value, client: report.successful_client!, last_success: report.successful_client })}>
        {q("Использовать", "Use")} {label(report.successful_client)}
      </button>}
      <details><summary>{q("Диагностика HTTP", "HTTP diagnostics")}</summary>
        {report.attempts.map((a, i) => <p key={i}>{label(a.client)} · HTTP {a.http_status ?? "—"} · {a.format ?? "—"} · {reason(a.result)} · {q("Узлы / пропущено", "Nodes / skipped")}: {a.recognized} / {a.skipped}<br />sing-box / Xray / Mihomo: {a.supported.join(" / ")} <code>{a.result}</code>{a.device && <><br />{q("ID отправлен", "ID sent")}: {a.device.id_sent ? q("да", "yes") : q("нет", "no")} · x-hwid-not-supported: {String(a.device.not_supported)} · x-hwid-max-devices-reached: {String(a.device.max_devices_reached)} · x-hwid-limit: {String(a.device.legacy_limit)}</>}</p>)}
      </details>
    </div>}
    <details className="subscription-http"><summary>{q("Дополнительные настройки HTTP", "Advanced HTTP settings")}</summary>
      {value.client === "custom" && <label className="field"><span>User-Agent</span><input value={userAgent} disabled={busy || checking} maxLength={512} spellCheck={false} onChange={e => setUserAgent(e.target.value)} /></label>}
      <label className="field"><span>Accept</span><input value={value.accept ?? ""} placeholder="*/*" maxLength={256} disabled={busy || checking} onChange={e => onChange({ ...value, accept: e.target.value || null })} /></label>
      <label className="checkbox-row"><input type="checkbox" checked={value.send_device_id} disabled={busy || checking} onChange={e => onChange({ ...value, send_device_id: e.target.checked, device_id: value.device_id ?? (e.target.checked ? crypto.randomUUID() : null) })} />{q("Отправлять локальный идентификатор этой подписки", "Send this subscription’s local device ID")}</label>
      <p className="hint">{q("В заголовке x-hwid отправляется случайный постоянный ID. Данные оборудования и Windows не читаются. Провайдер может занять слот устройства. Отключение не освобождает слот у провайдера.", "x-hwid sends a stable random ID. No hardware or Windows identifiers are read. This may consume a provider device slot; disabling does not release that slot.")}</p>
      <p className="hint">{q("Отправляемые сведения", "Sent information")}: User-Agent, Accept{value.send_device_id ? ", x-hwid (" + q("локальный ID скрыт", "local ID hidden") + ")" : ""}.</p>
    </details>
  </div>;
}
