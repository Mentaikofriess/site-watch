// site-watch — pure helpers (tested in tests/lib.test.mjs). No dependencies.

// A CDN answering 403/429 itself (its `server` header, not the origin's) is
// refusing this vantage, not reporting the site down. Found on the first
// GitHub run (2026-09-24): Hostinger's CDN (`server: hcdn`) sends 403 to
// GitHub's runner IPs for burntends, meatsmith and cellars, while the Mac
// gets 200 with the same user-agent. Sites served straight from LiteSpeed
// (bakery, xpress) aren't affected.
const CDN_SERVER = /^(hcdn|cloudflare)$/i;
export function cdnRefused(p) {
  return !p.ok && (p.status === 403 || p.status === 429) && CDN_SERVER.test(p.server ?? "");
}

/** Verdict for one site from its per-family probe results. */
export function siteState(site, probes) {
  const v4 = probes.v4;
  const v6 = probes.v6; // undefined when not checked / runner has no IPv6
  if (cdnRefused(v4)) return { state: "blocked", reason: `HTTP ${v4.status} from the ${v4.server} CDN — it refuses this vantage's IPs; the site is not checked from here` };
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
 * - blocked (a CDN refuses this vantage): silent. It says nothing about the
 *   site, so it neither alerts nor clears the last alerted state, except that
 *   down → blocked is sent once as a correction.
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
    if (cur.state === "blocked" && lastAlerted !== "down") continue;
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
  const icon = t.to === "up" ? "✅" : t.to === "degraded" ? "⚠️" : t.to === "blocked" ? "ℹ️" : "🔴";
  return `${icon} [site-watch] ${t.id} ${t.from} → ${t.to}\n${url}\n${t.reason}\n(checked from ${vantage})`;
}
