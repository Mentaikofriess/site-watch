import { test } from "node:test";
import assert from "node:assert/strict";
import { cdnRefused, daysUntil, formatAlert, siteState, transitions } from "../lib.mjs";

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

test("down alerts at once; degraded needs 2 runs; new healthy site is silent", () => {
  const r1 = transitions({ a: { state: "up", alerted: "up" }, b: { state: "up", alerted: "up" } }, { a: { state: "down", reason: "x" }, b: { state: "degraded", reason: "slow" }, c: { state: "up", reason: "z" } });
  assert.deepEqual(r1.alerts.map((t) => `${t.id}:${t.from}->${t.to}`), ["a:up->down"]);
  const r2 = transitions(r1.next, { a: { state: "down", reason: "x" }, b: { state: "degraded", reason: "slow" }, c: { state: "up", reason: "z" } });
  assert.deepEqual(r2.alerts.map((t) => `${t.id}:${t.from}->${t.to}`), ["b:up->degraded"]);
  const r3 = transitions(r2.next, { a: { state: "up", reason: "ok" }, b: { state: "up", reason: "ok" }, c: { state: "up", reason: "z" } });
  assert.deepEqual(r3.alerts.map((t) => `${t.id}:${t.from}->${t.to}`), ["a:down->up"]);
});

test("a one-run blip never alerts", () => {
  const r1 = transitions({ a: { state: "up", alerted: "up" } }, { a: { state: "degraded", reason: "slow" } });
  const r2 = transitions(r1.next, { a: { state: "up", reason: "ok" } });
  assert.equal(r1.alerts.length + r2.alerts.length, 0);
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
  assert.deepEqual(transitions(fromUp.next, { a: { state: "down", reason: "HTTP 503" } }).alerts.map((t) => t.to), ["down"]);
});
