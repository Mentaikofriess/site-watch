// site-watch — checks every site in sites.json over IPv4 (and IPv6 where
// available), writes state/latest.json + appends state/checks.jsonl, and sends
// a Telegram message on state CHANGES only. Zero dependencies, Node 22+.
//   node check.mjs [--vantage github|mac] [--no-alert]
// Env (optional): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
import https from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { daysUntil, formatAlert, siteState, transitions } from "./lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const VANTAGE = arg("--vantage", process.env.GITHUB_ACTIONS ? "github" : "mac");
const STATE_DIR = new URL(`./state/${VANTAGE}/`, import.meta.url);
const TIMEOUT = 20_000;

function probe(url, family, expectText, hops = 0) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(url, { family, timeout: TIMEOUT, headers: { "user-agent": "site-watch/1.0 (+uptime check)" } }, (res) => {
      const cert = res.socket.getPeerCertificate?.();
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops < 5) {
        res.resume();
        return resolve(probe(new URL(loc, url).toString(), family, expectText, hops + 1));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 400_000) body += c; });
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode,
        ms: Date.now() - t0,
        textOk: expectText ? body.includes(expectText) : true,
        tlsDaysLeft: cert?.valid_to ? daysUntil(cert.valid_to) : null,
      }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${TIMEOUT / 1000}s`)));
    req.on("error", (e) => resolve({ ok: false, status: null, ms: Date.now() - t0, error: e.code ? `${e.code} ${e.message}`.slice(0, 160) : e.message, textOk: false, tlsDaysLeft: null }));
  });
}

// One retry after 5 s: a single timeout is noise (both Meatsmith and the
// Cellars IPv6 path flapped during the first real runs, 2026-09-23).
async function probeTwice(url, family, expectText) {
  const first = await probe(url, family, expectText);
  if (first.ok && first.textOk) return first;
  await new Promise((r) => setTimeout(r, 5000));
  const second = await probe(url, family, expectText);
  return second.ok ? second : { ...second, error: `${second.error ?? `HTTP ${second.status}`} (twice)` };
}

async function hasIPv6() {
  const r = await probe("https://www.google.com/generate_204", 6);
  return r.ok;
}

async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat || process.argv.includes("--no-alert")) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`telegram: HTTP ${r.status}`);
  return r.ok;
}

const { sites } = JSON.parse(readFileSync(new URL("./sites.json", import.meta.url), "utf8"));
const v6 = await hasIPv6();
const now = new Date().toISOString();
const current = {};
for (const site of sites) {
  const probes = { v4: await probeTwice(site.url, 4, site.expectText) };
  if (site.ipv6 && v6) probes.v6 = await probeTwice(site.url, 6);
  current[site.id] = { ...siteState(site, probes), url: site.url, group: site.group, ms: probes.v4.ms, ipv6Checked: !!probes.v6 };
}

mkdirSync(STATE_DIR, { recursive: true });
const latestPath = new URL("latest.json", STATE_DIR);
const previous = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, "utf8")).sites : {};
const { next, alerts: changes } = transitions(previous, current);
for (const t of changes) await sendTelegram(formatAlert(t, current[t.id].url, VANTAGE));
writeFileSync(latestPath, JSON.stringify({ checkedAt: now, vantage: VANTAGE, ipv6Available: v6, sites: next }, null, 2) + "\n");
// History: one line per run, pruned to the last 30 days so the repo stays small.
const histPath = new URL("checks.jsonl", STATE_DIR);
const cutoff = Date.now() - 30 * 86_400_000;
const kept = existsSync(histPath) ? readFileSync(histPath, "utf8").split("\n").filter((l) => l && Date.parse(JSON.parse(l).at) >= cutoff) : [];
kept.push(JSON.stringify({ at: now, sites: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, [v.state, v.ms]])) }));
writeFileSync(histPath, kept.join("\n") + "\n");
console.log(`${now} ${VANTAGE} ipv6=${v6} ` + Object.entries(current).map(([k, v]) => `${k}=${v.state}`).join(" "));
for (const [k, v] of Object.entries(current)) if (v.state !== "up") console.log(`  ${k}: ${v.reason}`);
for (const t of changes) console.log(`change: ${t.id} ${t.from} → ${t.to} (${t.reason})`);
