/** Presentation-only redaction. Never feed this text back to a configuration API. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:ss|ssr|vmess|vless|trojan|socks5?|hysteria2?|hy2|tuic):\/\/[^\s<>"']+/gi,
      value => value.slice(0, value.indexOf("://") + 3) + "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password) { url.username = "redacted"; url.password = "redacted"; }
        for (const key of [...url.searchParams.keys()]) {
          if (/token|key|secret|auth|password|credential|signature|^id$/i.test(key)) url.searchParams.set(key, "[redacted]");
        }
        url.pathname = url.pathname.replace(/[^/]{20,}/g, "[redacted]");
        url.hash = "";
        return url.toString();
      } catch { return "[redacted URL]"; }
    })
    .replace(/((?:["']?(?:password|passwd|token|access_token|secret|private_key|authorization|uuid)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [redacted]");
}
