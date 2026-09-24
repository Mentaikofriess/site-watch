import { test } from "node:test";
import assert from "node:assert/strict";
import { cdnRefused, daysUntil, digest, formatAlert, historyLine, siteState, transitions } from "../lib.mjs";

const ok = { ok: true, status: 200, ms: 300, textOk: true, tlsDaysLeft: 60 };

test("up / down / missing text", () => {
  assert.equal(siteState({}, { v4: ok }).state, "up");
  assert.equal(siteState({}, { v4: { ...ok, ok: false, status: 503 } }).reason, "HTTP 503");
  assert.equal(siteState({ expectText: "Lucas" }, { v4: { ...ok, textOk: false } }).state, "down");
});

test("degraded: slow, IPv6 broken, TLS expiring — each named", () => {
  const r = siteState({ maxMs: 100 }, { v4: { ...ok, tlsDaysLeft: 5 }, v6: { ok: false, error: "ETIMEDOUT" } });
  assert.equal(r.state, "degraded");
  assert.match(r.reason, /slow: 300 ms/);
  assert.match(r.reason, /IPv6 broken: ETIMEDOUT \(IPv4 fine\)/);
  assert.match(r.reason, /expires in 5 day/);
});

const pings = (r) => r.alerts.map((t) => `${t.id}:${t.from}->${t.to}`);

test("down pings only on its 2nd consecutive run; recovery pings only after a pinged down", () => {
  const r1 = transitions({ a: { state: "up", alerted: "up" } }, { a: { state: "down", reason: "HTTP 503" } });
  assert.deepEqual(pings(r1), []);
  const r2 = transitions(r1.next, { a: { state: "down", reason: "HTTP 503" } });
  assert.deepEqual(pings(r2), ["a:up->down"]);
  const r3 = transitions(r2.next, { a: { state: "down", reason: "HTTP 503" } });
  assert.deepEqual(pings(r3), []);
  const r4 = transitions(r3.next, { a: { state: "up", reason: "ok" } });
  assert.deepEqual(pings(r4), ["a:down->up"]);
});

test("a one-run down blip, degraded and new sites never ping", () => {
  const r1 = transitions({ a: { state: "up", alerted: "up" }, b: { state: "up", alerted: "up" } }, { a: { state: "down", reason: "x" }, b: { state: "degraded", reason: "slow" }, c: { state: "up", reason: "z" } });
  const r2 = transitions(r1.next, { a: { state: "up", reason: "ok" }, b: { state: "degraded", reason: "slow" }, c: { state: "down", reason: "t" } });
  const r3 = transitions(r2.next, { a: { state: "up", reason: "ok" }, b: { state: "up", reason: "ok" }, c: { state: "up", reason: "ok" } });
  assert.equal(r1.alerts.length + r2.alerts.length + r3.alerts.length, 0);
});

test("helpers", () => {
  assert.equal(daysUntil("2026-10-03T00:00:00Z", new Date("2026-09-23T00:00:00Z")), 10);
  assert.equal(daysUntil("nope"), null);
  assert.match(formatAlert({ id: "a", from: "up", to: "down", reason: "r" }, "https://x", "github"), /🔴 \[site-watch\] a up → down/);
});

test("a CDN's own 403 is 'blocked', not 'down'; the origin's 403 is still down", () => {
  const hcdn = { ok: false, status: 403, server: "hcdn", ms: 50, textOk: false, tlsDaysLeft: 60 };
  assert.equal(siteState({}, { v4: hcdn }).state, "blocked");
  assert.equal(siteState({}, { v4: { ...hcdn, server: "LiteSpeed" } }).state, "down");
  assert.equal(siteState({}, { v4: { ...hcdn, status: 503 } }).state, "down");
  assert.equal(cdnRefused({ ...hcdn, status: 429, server: "cloudflare" }), true);
});

test("blocked is silent, except once as a correction after a false 'down'", () => {
  const fromDown = transitions({ a: { state: "down", alerted: "down" } }, { a: { state: "blocked", reason: "cdn" } });
  assert.deepEqual(fromDown.alerts.map((t) => `${t.id}:${t.from}->${t.to}`), ["a:down->blocked"]);
  assert.equal(transitions(fromDown.next, { a: { state: "blocked", reason: "cdn" } }).alerts.length, 0);
  const fromUp = transitions({ a: { state: "up", alerted: "up" } }, { a: { state: "blocked", reason: "cdn" } });
  assert.equal(fromUp.alerts.length, 0);
  assert.equal(transitions(fromUp.next, { a: { state: "up", reason: "ok" } }).alerts.length, 0);
  assert.equal(transitions({}, { a: { state: "blocked", reason: "cdn" } }).alerts.length, 0);
  const d1 = transitions(fromUp.next, { a: { state: "down", reason: "HTTP 503" } });
  assert.deepEqual(transitions(d1.next, { a: { state: "down", reason: "HTTP 503" } }).alerts.map((t) => t.to), ["down"]);
});

test("history keeps the reason only for non-up sites", () => {
  assert.deepEqual(historyLine("t", { a: { state: "up", ms: 90, reason: "200" }, b: { state: "down", ms: 20000, reason: "timeout" } }).sites, { a: ["up", 90], b: ["down", 20000, "timeout"] });
});

test("digest: periods with first/last seen, when cleared, the error; clean, blocked and missing-checks lines", () => {
  const now = new Date("2026-09-25T02:00:00Z"); // 10:00 SGT
  const at = (h, m) => new Date(Date.UTC(2026, 8, 24, h, m)).toISOString();
  const run = (t, a, b, c) => ({ at: t, sites: { a, b, c } });
  const up = ["up", 100];
  const lines = [
    { at: "2026-09-23T00:00:00Z", sites: { a: ["down", 1, "old"] } }, // older than 24 h: ignored
    run(at(3, 0), up, ["blocked", 50, "cdn"], up),
    run(at(3, 5), ["down", 20000, "timeout after 20s (twice)"], ["blocked", 50, "cdn"], ["degraded", 7000, "slow: 7000 ms (limit 6000)"]),
    run(at(3, 10), ["down", 20000, "HTTP 503 (twice)"], ["blocked", 50, "cdn"], up),
    run(at(3, 15), up, ["blocked", 50, "cdn"], up),
  ];
  const text = digest(lines, ["a", "b", "c"], now, 288);
  assert.match(text, /4 checks ran \(expected ≈ 288\)/);
  assert.match(text, /🔴 a\n   down 11:05–11:10 \(2 checks\), up again 11:15 — timeout after 20s \(twice\) \/ HTTP 503 \(twice\)/);
  assert.match(text, /⚠️ c\n   degraded 11:05 \(1 check\), up again 11:10 — slow/);
  assert.match(text, /ℹ️ not visible from GitHub.*: b/);
  assert.doesNotMatch(text, /old/);
  assert.match(digest([run(at(3, 0), up, up, up)], ["a", "b", "c"], now, 288), /✅ up at every check: a, b, c/);
  assert.match(digest([], ["a"], now, 288), /No checks at all/);
});

test("digest: a period still open at the last check says so", () => {
  const now = new Date("2026-09-25T02:00:00Z");
  const text = digest([{ at: "2026-09-25T01:55:00Z", sites: { a: ["down", 1, "HTTP 500"] } }], ["a"], now, 288);
  assert.match(text, /down 09:55 \(1 check\), still at the last check — HTTP 500/);
});
