// site-watch — pure helpers (tested in tests/lib.test.mjs). No dependencies.

/** Verdict for one site from its per-family probe results. */
export function siteState(site, probes) {
  const v4 = probes.v4;
  const v6 = probes.v6; // undefined when not checked / runner has no IPv6
  if (!v4.ok) return { state: "down", reason: v4.error ?? `HTTP ${v4.status}` };
  if (site.expectText && !v4.textOk) return { state: "down", reason: `page loaded but "${site.expectText}" is missing` };
  const issues = [];
  if (site.maxMs && v4.ms > site.maxMs) issues.push(`slow: ${v4.ms} ms (limit ${site.maxMs})`);
  if (v6 && !v6.ok) issues.push(`IPv6 broken: ${v6.error ?? `HTTP ${v6.status}`} (IPv4 fine)`);
  if (v4.tlsDaysLeft !== null && v4.tlsDaysLeft < 14) issues.push(`TLS certificate expires in ${v4.tlsDaysLeft} day(s)`);
  return issues.length ? { state: "degraded", reason: issues.join("; ") } : { state: "up", reason: `${v4.status} in ${v4.ms} ms` };
}

/**
 * Carries each site's state streak forward and decides what to alert.
 * - down, and recovery from down: alert at once (the check already retried).
 * - degraded (slow / IPv6 / TLS) and recovery from degraded: only once the new
 *   state has held for 2 consecutive runs — single slow responses are noise.
 * - a brand-new site that is up: silent.
 * Returns the next per-site record ({state, streak, alerted}) and the alerts.
 */
export function transitions(previous, current) {
  const next = {};
  const alerts = [];
  for (const [id, cur] of Object.entries(current)) {
    const prev = previous?.[id];
    const streak = prev && prev.state === cur.state ? (prev.streak ?? 1) + 1 : 1;
    const lastAlerted = prev?.alerted ?? (prev ? prev.state : undefined);
    next[id] = { ...cur, streak, alerted: lastAlerted };
    if (lastAlerted === cur.state) continue;
    if (lastAlerted === undefined && cur.state === "up") { next[id].alerted = "up"; continue; }
    const immediate = cur.state === "down" || lastAlerted === "down";
    if (immediate || streak >= 2) {
      alerts.push({ id, from: lastAlerted ?? "new", to: cur.state, reason: cur.reason });
      next[id].alerted = cur.state;
    }
  }
  return { next, alerts };
}

export function daysUntil(dateString, now = new Date()) {
  const t = Date.parse(dateString);
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 86_400_000);
}

export function formatAlert(t, url, vantage) {
  const icon = t.to === "up" ? "✅" : t.to === "degraded" ? "⚠️" : "🔴";
  return `${icon} [site-watch] ${t.id} ${t.from} → ${t.to}\n${url}\n${t.reason}\n(checked from ${vantage})`;
}
