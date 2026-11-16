import {useEffect, useMemo, useRef, useState} from 'react';
import {routingProcesses, type RoutingProcess} from '../../api';
import {useRoutingText} from './messages';

type Entry = {name: string; path: string; pids: number[]};
export function ProcessPicker({core, onChoose, onClose}: {
  core: string;
  onChoose: (field: 'process_name' | 'process_path', value: string, name: string) => void;
  onClose: () => void;
}) {
  const t = useRoutingText();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'process_name' | 'process_path'>('process_name');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const key = (entry: Entry) => `${entry.name}\0${entry.path}`;

  async function refresh() {
    const id = ++request.current;
    setLoading(true);
    setError(false);
    try {
      const result = await routingProcesses();
      const processes: RoutingProcess[] = result ? Array.isArray(result) ? result : [result] : [];
      const groups = new Map<string, Entry>();
      for (const process of processes) {
        const path = process.Path?.trim() ?? '';
        const rawName = path.split(/[\\/]/).pop() || process.ProcessName?.trim();
        if (!rawName || (!path && ['Idle', 'System', 'Registry', 'Memory Compression'].includes(rawName))) continue;
        const name = /\.exe$/i.test(rawName) ? rawName : `${rawName}.exe`;
        const entryKey = `${name.toLowerCase()}\0${path.toLowerCase()}`;
        const entry = groups.get(entryKey) ?? {name, path, pids: []};
        if (process.Id != null && !entry.pids.includes(process.Id)) entry.pids.push(process.Id);
        groups.set(entryKey, entry);
      }
      if (request.current !== id) return;
      const next = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      setEntries(next);
      setSelected(previous => next.some(entry => key(entry) === previous) ? previous : '');
    } catch {
      if (request.current === id) setError(true);
    } finally {
      if (request.current === id) setLoading(false);
    }
  }
  useEffect(() => {void refresh(); return () => {request.current++};}, []);
  const rows = useMemo(() => {
    const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return entries.filter(entry => {
      const text = `${entry.name} ${entry.path} ${entry.pids.join(' ')}`.toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
  }, [entries, search]);
  const entry = rows.find(row => key(row) === selected);
  const field = core === 'xray' ? 'process_name' : mode;
  const canChoose = !!entry && (field !== 'process_path' || !!entry.path);

  return <section className="routing-process-picker" aria-label={t('processes')} aria-busy={loading}>
    <header><strong>{t('processes')}</strong><button type="button" onClick={onClose} aria-label={t('close')}>×</button></header>
    <div className="routing-inline">
      <input autoFocus type="search" aria-label={t('processSearch')} placeholder={t('processSearch')} value={search} onChange={event => setSearch(event.target.value)}/>
      <button type="button" onClick={() => void refresh()} disabled={loading}>{t('processRefresh')}</button>
    </div>
    <p className="routing-hint" role="status">{loading ? t('processLoading') : `${t('processFound')}: ${rows.length} / ${entries.length}`}</p>
    {error ? <p role="alert">{t('routing.process.unavailable')}</p> :
      <ul className="routing-process-list" aria-label={t('processList')}>
        {rows.map(row => <li key={key(row)}><button type="button" className={selected === key(row) ? 'selected' : ''} aria-pressed={selected === key(row)} onClick={() => setSelected(key(row))} disabled={loading}>
          <strong>{row.name}</strong><span className="routing-process-pid">PID: {row.pids.length ? row.pids.join(', ') : '—'}</span>
          <small>{row.path || t('processNoPath')}</small>
        </button></li>)}
        {!loading && !rows.length && <li className="routing-empty">{entries.length ? t('processNoMatches') : t('processEmpty')}</li>}
      </ul>}
    <div className="routing-process-match"><span>{t('processMatch')}</span>
      <div className="routing-process-modes" role="group" aria-label={t('processMatch')}>
        <button type="button" className={field === 'process_name' ? 'active' : ''} aria-pressed={field === 'process_name'} onClick={() => setMode('process_name')}>{t('processByName')}</button>
        <button type="button" className={field === 'process_path' ? 'active' : ''} aria-pressed={field === 'process_path'} disabled={core === 'xray'} onClick={() => setMode('process_path')}>{t('processByPath')}</button>
      </div>
    </div>
    <p className="routing-hint">{t(field === 'process_name' ? 'processNameHelp' : 'processPathHelp')}{core === 'xray' && ` ${t('routing.xray.process_path')}`}</p>
    {!entry && <p className="routing-hint">{t('processSelectFirst')}</p>}
    {entry && !canChoose && <p className="routing-hint" role="status">{t('processPathUnavailable')}</p>}
    <div className="routing-inline"><button type="button" className="routing-primary" disabled={!canChoose || loading || error} onClick={() => {if (entry && canChoose) onChoose(field, field === 'process_path' ? entry.path : entry.name, entry.name)}}>{t('processUse')}</button><button type="button" onClick={onClose}>{t('cancel')}</button></div>
  </section>;
}
