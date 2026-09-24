# site-watch

Checks Lucas's and BEHG's websites from GitHub's servers, so it keeps
watching while the Mac is asleep: **every 5 minutes once the repo is public**
(Actions are free on public repos; hourly at :35 until then). A second copy
runs hourly on the Mac through Command Center's scheduler. It's the only place
that can test **IPv6** (GitHub's runners have none), and it never messages
Telegram. Part of Command Center's N-series (N3), 2026-09-23.

**What Telegram gets (Lucas, 2026-09-24):**
- **A daily digest at 10:00 SGT** (`digest.yml`), sent even when all is
  well: each site's down/slow periods over the last 24 h (first and last seen,
  the check that saw it up again, the error), sites up at every check, and how
  many checks actually ran.
- **An immediate ping only for a sustained outage**: down on 2 checks in a
  row (≈ 5–10 min at 5-minute checks), then one "back up" ping. One-check
  blips and slow/IPv6/TLS issues go to the digest only.

What it checks per site: HTTP status (following redirects), load time vs a
limit, an optional text that must appear on the page, days until the TLS
certificate expires, and — from the Mac — IPv4 and IPv6 separately.
States: **up**, **degraded** (slow / IPv6 broken / TLS < 14 days), **down**,
**blocked** (a CDN refuses this vantage; see the end of this file). Each check
retries once after 5 s. Checks are samples: an outage shorter than the gap
between checks can be missed, and a period's real length is somewhere between
"first seen → last seen" and "last up → up again".

## One-time setup (≈10 minutes)

### 1. Make a Telegram bot for these alerts

You *can* reuse the trading bot, but a separate bot is simpler: GitHub never
shows a saved secret again, so the trading bot's token would have to be dug
out of @BotFather anyway — and separate bots keep site alerts and trading
alerts in different chats.

1. In Telegram, open **@BotFather** → send `/newbot`.
2. Name it (e.g. `BEHG Site Watch`), then a username ending in `bot`
   (e.g. `behg_site_watch_bot`).
3. BotFather replies with a **token** like `123456789:AAH…`. Treat it like a
   password — don't paste it anywhere except step 5.
4. Open a chat with your new bot and send it any message (`hi`). Bots can't
   message you first.
5. In a browser, open `https://api.telegram.org/bot<TOKEN>/getUpdates`
   (your token in place of `<TOKEN>`). Find `"chat":{"id":123456789` — that
   number is the **chat id**. (For a group instead: add the bot to the group,
   send a message there; group ids are negative, e.g. `-100…`.)

### 2. Create the GitHub repo and add the two secrets

1. github.com → **New repository** → owner `Mentaikofriess`, name
   **`site-watch`**, **Private**, *don't* add a README/licence → Create.
2. Repo → **Settings → Secrets and variables → Actions → New repository
   secret**, twice:
   - `TELEGRAM_BOT_TOKEN` = the token from step 1.3
   - `TELEGRAM_CHAT_ID` = the number from step 1.5
3. Tell Claude — it pushes this folder and triggers the first run
   (**Actions → watch → Run workflow**). A healthy first run is silent by
   design; a test alert is sent by temporarily adding a broken URL.

## Adding a site

Add one entry to `sites.json` and push:

```json
{ "id": "new-client", "group": "clients", "url": "https://example.com/", "expectText": "Book now", "maxMs": 5000, "ipv6": true }
```

`id` must be unique; `expectText` is optional (use a word that only appears
when the page really rendered); `maxMs` is the "slow" line.

## Cost — and when you'd want more frequent checks

GitHub bills Actions **per job, rounded up to the minute**. One run checks
every site in one job (~20–40 s today), so **adding sites costs nothing**
until a run passes 60 s; only the **frequency** matters. Private repos get
**2,000 free minutes a month per account — shared with every other private
repo's Actions (Trade automation's daily runs use some)**. Beyond that, Linux
minutes cost **US$0.006/min** (2026 price).

| Every | Runs / month | Minutes / month | Est. cost (private repo) |
|---|---|---|---|
| **60 min (now)** | 720 | ~720 | **$0** (inside 2,000, if other repos stay under ~1,280) |
| 30 min | 1,440 | ~1,440 | $0 (inside 2,000, if other repos stay under ~560) |
| 15 min | 2,880 | ~2,880 | ~$5.30 |
| 10 min | 4,320 | ~4,320 | ~$14 |
| 5 min (GitHub's minimum) | 8,640 | ~8,640 | ~$40 |

A site that's **down** makes that run longer (timeouts + retry ≈ +45 s), which
can push a run to 2 billed minutes — only while something is broken.

**When to go faster:** a site starts taking orders or bookings that lose real
money per minute of downtime (e.g. a Woo store during a launch or festive
peak), or a client's contract promises a response time. Cheaper routes than
paying per minute:
- **Make this repo public** — public repos' Actions are free, at any
  frequency. Nothing secret is in it (public URLs + status history); the
  Telegram secrets stay secret.
- **Cloudflare Workers cron** (free plan) can run every minute — worth it
  only if 1–5-minute detection ever matters.

Also note GitHub may start scheduled runs a few minutes late, or skip one
when its queues are busy — "hourly" means about hourly, not a guarantee.

## Running it yourself

```bash
node check.mjs --vantage mac --no-alert   # check now, no Telegram
npm test                                  # the pure logic
```

Results: `state/<vantage>/latest.json` (current) and `checks.jsonl` (30 days).
Only `state/github/` is committed; `state/mac/` stays local.

## Known issue found on day one (2026-09-23)

`burntendscellars.com.sg` publishes IPv6 addresses (Hostinger) that
intermittently don't answer while IPv4 works. Visitors whose network prefers
IPv6 can see a stall. Fix at the DNS host: repair or remove the apex's AAAA
records. The Mac-side check reports it as **degraded: IPv6 broken** when it
happens.

## Hostinger's CDN blocks GitHub (found 2026-09-24)

On the first GitHub run, burntends.com.sg, meatsmith.com.sg and
burntendscellars.com.sg returned **HTTP 403** and were reported down. They
weren't: the Mac got 200 with the same request. These three go through
Hostinger's CDN (`server: hcdn`), which refuses GitHub's runner IPs; bakery
and xpress are served directly (LiteSpeed) and pass.

A 403/429 whose `server` header is the CDN's own (`hcdn`, `cloudflare`) is now
state **blocked**, not down. It never alerts, except one "down → blocked"
message to correct an earlier false "down". A 403 from the site itself, a 5xx
or a timeout is still **down**. Those three sites are therefore only checked
from the Mac (hourly, while it's awake). To get GitHub coverage back,
someone with BEHG's hPanel would allow-list or relax the CDN's bot/security
setting for these domains. That is BEHG's call, not a change to make here.
