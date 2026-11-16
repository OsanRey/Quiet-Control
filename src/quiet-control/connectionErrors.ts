/** Display evidence only: a core log error is not a global connectivity verdict. */
export function recentConnectionError(lines: string[], since: number, now: number, nodeId?: string | null): string | null {
  const tag = nodeId ? `node-${nodeId.slice(0,16)}` : null;
  for (const raw of [...lines].reverse()) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const match = /^([+-]\d{2})(\d{2}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:ERROR|FATAL) (.*)$/.exec(line);
    if (!match) continue;
    const at = Date.parse(`${match[3]}T${match[4]}${match[1]}:${match[2]}`);
    if (!Number.isFinite(at) || at < Math.max(since, now - 60_000) || at > now + 2000) continue;
    const outbound = /using outbound\/[^[]+\[([^\]]+)\]/.exec(match[5]);
    if (tag && outbound?.[1] !== tag) continue;
    // A captured application's TCP reset or failed DNS lookup is not evidence
    // that the selected VPN transport failed. Keep those events in Logs.
    if (/reality verification failed|stream error/i.test(match[5])) return line;
  }
  return null;
}
