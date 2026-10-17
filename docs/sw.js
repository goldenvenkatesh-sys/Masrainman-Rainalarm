/* MasRainman Rain Alarm -- service worker.
 * - keeps the app shell available offline (radar data is always fetched fresh)
 * - on Android Chrome (installed app) it can wake up in the background via
 *   Periodic Background Sync and raise the same alarm the open app would.
 */
const SHELL = "ra-shell-v2";
const FILES = ["./", "index.html", "app.css", "app.js", "engine.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/logo.png", "icons/mark.png", "icons/badge-96.png", "data/places.json", "data/boundaries.json"];

importScripts("engine.js");

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("ra-shell") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // live radar data: network only (stale radar is worse than none)
  if (url.pathname.includes("/data/") && !/places\.json|boundaries\.json/.test(url.pathname)) return;
  // app files: network first, cached copy when offline
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    if (r.ok) caches.open(SHELL).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

/* ---------- background check (same rules as the page) ---------- */
async function backgroundCheck() {
  const clientsNow = await self.clients.matchAll({ type: "window" });
  if (clientsNow.some((c) => c.visibilityState === "visible")) {   // the open page handles it
    clientsNow.forEach((c) => c.postMessage("refresh"));
    return;
  }
  const c = await caches.open("ra-config");
  const r = await c.match("config.json");
  if (!r) return;
  const cfg = await r.json();
  const S = cfg.settings || {}, places = cfg.places || [], log = cfg.alerts || {};
  if (!places.length) return;
  const s = { thr: S.thr || 30, windowMin: S.windowMin || 60 };
  let imd = null;
  try { imd = await RA.loadImd(new URL("data/", self.registration.scope).href); } catch (e) { /* offline */ }
  const minLvl = S.near ? 1 : 2;
  for (const p of places) {
    let res = imd ? RA.evaluateImd(imd, p, s) : null;
    if (!res) { try { res = await RA.evaluateModel(p, s); } catch (e) { continue; } }
    if (!res || res.level < minLvl) continue;
    if (res.level === 1 && !(res.near && res.near.approaching)) continue;
    const prev = log[p.id];
    if (prev && Date.now() - prev.at < 90 * 60000 && res.level <= prev.level) continue;
    log[p.id] = { level: res.level, at: Date.now(), dbz: Math.max(res.now, res.peak || 0) };
    const lang = S.lang === "en" ? "en" : "ta";
    const d = RA.describe(res, p, s);
    await self.registration.showNotification(RA.alarmTitle(res, p, lang), {
      body: S.lang === "en" ? d.en : S.lang === "ta" ? d.ta : d.ta + "\n" + d.en,
      tag: "ra-" + p.id, renotify: true, icon: "icons/icon-192.png", badge: "icons/badge-96.png",
      vibrate: S.vibrate === false ? [] : [500, 200, 500, 200, 900], requireInteraction: true,
    });
  }
  cfg.alerts = log;
  await c.put("config.json", new Response(JSON.stringify(cfg)));
}
self.addEventListener("periodicsync", (e) => { if (e.tag === "ra-check") e.waitUntil(backgroundCheck()); });
self.addEventListener("message", (e) => { if (e.data === "check") e.waitUntil(backgroundCheck()); });

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
