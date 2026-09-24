// site-watch — the daily digest (10:00 SGT, .github/workflows/digest.yml):
// every site's down/slow periods over the last 24 h, with the errors, from
// this vantage's state/<vantage>/checks.jsonl. Always sends, even when all
// is well, so silence never means "the digest broke".
//   node digest.mjs [--vantage github|mac] [--print]
import { existsSync, readFileSync } from "node:fs";
import { digest } from "./lib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const VANTAGE = arg("--vantage", process.env.GITHUB_ACTIONS ? "github" : "mac");
const hist = new URL(`./state/${VANTAGE}/checks.jsonl`, import.meta.url);
const { sites } = JSON.parse(readFileSync(new URL("./sites.json", import.meta.url), "utf8"));
// Expected checks per day from the watch workflow's cron (every N minutes, or hourly).
const cron = /cron:\s*"([^"]+)"/.exec(readFileSync(new URL("./.github/workflows/watch.yml", import.meta.url), "utf8"))?.[1] ?? "";
const every = /^\*\/(\d+) /.exec(cron)?.[1];
const expected = every ? Math.round(1440 / Number(every)) : 24;

const lines = existsSync(hist) ? readFileSync(hist, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const text = digest(lines, sites.map((s) => s.id), new Date(), expected);
console.log(text);

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
if (token && chat && !process.argv.includes("--print")) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) { console.error(`telegram: HTTP ${r.status}`); process.exit(1); }
}
