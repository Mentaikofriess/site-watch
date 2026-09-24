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
 * Carries each site's state streak forward and decides what to ping at once.
 * Lucas (2026-09-24): Telegram should be a daily digest plus pings only for
 * sustained outages, so:
 * - down: ping once it has held for 2 consecutive runs (each run already
 *   retries after 5 s). At 5-minute checks that's ≈ 5–10 min of downtime.
 * - recovery: ping only if the down was pinged (closes the loop).
 * - degraded (slow / IPv6 / TLS): never pinged; it's in the digest.
 * - blocked (a CDN refuses this vantage): silent, except down → blocked,
 *   which corrects an earlier false "down".
 * - a brand-new site: silent.
 * Returns the next per-site record ({state, streak, alerted}) and the pings.
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
    const send = () => { alerts.push({ id, from: lastAlerted ?? "new", to: cur.state, reason: cur.reason }); next[id].alerted = cur.state; };
    if (cur.state === "down") { if (streak >= 2) send(); continue; }
    if (lastAlerted === "down") { send(); continue; } // up, degraded or blocked after a pinged down
    if (cur.state === "up") next[id].alerted = "up"; // quietly track "all clear"
  }
  return { next, alerts };
}

/** One history line per run: {at, sites: {id: [state, ms, reason?]}}. */
export function historyLine(at, current) {
  return { at, sites: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.state === "up" ? [v.state, v.ms] : [v.state, v.ms, v.reason]])) };
}

const sgt = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" });

/**
 * The 10:00 SGT digest from the last 24 h of history lines (oldest first).
 * A "period" is a run of consecutive checks in the same non-up state. Checks
 * are samples, so a period is reported as first/last seen plus the next
 * check that saw it up again, not as an exact duration.
 */
export function digest(lines, siteIds, now, expectedRuns) {
  const since = now.getTime() - 86_400_000;
  const runs = lines.filter((l) => Date.parse(l.at) >= since);
  const out = [`📋 site-watch — last 24 h to ${sgt(now.toISOString())} SGT`, `${runs.length} check${runs.length === 1 ? "" : "s"} ran (expected ≈ ${expectedRuns})`];
  if (!runs.length) return out.concat("⚠️ No checks at all in 24 h. Is the workflow running?").join("\n");
  const clean = [];
  const blocked = [];
  const sections = [];
  for (const id of siteIds) {
    const periods = [];
    let open = null;
    for (const r of runs) {
      const [state, , reason] = r.sites[id] ?? [];
      if (!state) continue;
      if (state === "up") {
        if (open) { open.clearedAt = r.at; periods.push(open); open = null; }
        continue;
      }
      if (open && open.state === state) { open.last = r.at; open.n++; if (reason) open.reasons.add(reason); continue; }
      if (open) periods.push(open);
      open = { state, first: r.at, last: r.at, n: 1, reasons: new Set(reason ? [reason] : []) };
    }
    if (open) periods.push(open);
    const real = periods.filter((p) => p.state !== "blocked");
    if (periods.length && !real.length) { blocked.push(id); continue; }
    if (!real.length) { clean.push(id); continue; }
    const lines2 = real.map((p) => {
      const span = p.n > 1 ? `${sgt(p.first)}–${sgt(p.last)} (${p.n} checks)` : `${sgt(p.first)} (1 check)`;
      const end = p.clearedAt ? `, up again ${sgt(p.clearedAt)}` : ", still at the last check";
      return `   ${p.state} ${span}${end} — ${[...p.reasons].join(" / ") || "no detail"}`;
    });
    const icon = real.some((p) => p.state === "down") ? "🔴" : "⚠️";
    sections.push(`${icon} ${id}\n${lines2.join("\n")}`);
  }
  if (clean.length) out.push(`✅ up at every check: ${clean.join(", ")}`);
  out.push(...sections);
  if (blocked.length) out.push(`ℹ️ not visible from GitHub (Hostinger CDN blocks it; the Mac checks these): ${blocked.join(", ")}`);
  return out.join("\n");
}

export function daysUntil(dateString, now = new Date()) {
  const t = Date.parse(dateString);
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 86_400_000);
}

export function formatAlert(t, url, vantage) {
  const icon = t.to === "up" ? "✅" : t.to === "degraded" ? "⚠️" : t.to === "blocked" ? "ℹ️" : "🔴";
  return `${icon} [site-watch] ${t.id} ${t.from} → ${t.to}\n${url}\n${t.reason}\n(checked from ${vantage})`;
}
