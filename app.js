/* MasRainman Rain Alarm -- page logic (map, loop, places, alarm). */
(function () {
  "use strict";
  const RA = window.RA;

  /* ====================================================================== */
  /* settings + saved places (stored on this phone only)                    */
  /* ====================================================================== */
  const DEFAULTS = {
    lang: "both",           // "ta" | "en" | "both"
    thr: 30,                // alarm when >= this dBZ (20 light, 30 moderate, 40 heavy)
    windowMin: 60,          // how far ahead to warn
    sound: true, vibrate: true, near: false,
    quiet: false,           // no sound 11 PM - 6 AM
    source: "both",         // map layer: "imd" | "rv" | "both"
    basemap: "terrain",   // "terrain" | "light" | "dark"
    alarmOn: true,
    onboarded: false,
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ra." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("ra." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const S = Object.assign({}, DEFAULTS, store.get("settings", {}));
  let places = store.get("places", null) || (window.RA_SAMPLE_PLACES || []).slice();   // preview build ships sample places
  let alertLog = store.get("alerts", {});            // placeId -> {level, at, dbz}
  const saveSettings = () => { store.set("settings", S); mirrorToWorker(); };
  const savePlaces = () => { store.set("places", places); mirrorToWorker(); };

  async function mirrorToWorker() {
    // the service worker cannot read localStorage, so keep a copy in Cache Storage
    try {
      const c = await caches.open("ra-config");
      await c.put("config.json", new Response(JSON.stringify({ settings: S, places, alerts: alertLog })));
    } catch (e) { /* not available */ }
  }

  /* ====================================================================== */
  /* text                                                                   */
  /* ====================================================================== */
  const T = {
    title: ["Rain Alarm", "மழை அலாரம்"],
    myPlaces: ["My places", "என் இடங்கள்"],
    add: ["Add place", "இடம் சேர்"],
    now: ["Now", "இப்போது"],
    forecast: ["forecast", "முன்னறிவிப்பு"],
    past: ["past", "முன்பு"],
    myLoc: ["My location", "என் இருப்பிடம்"],
    stop: ["Stop alarm", "அலாரம் நிறுத்து"],
    search: ["Search town, area…", "ஊர், பகுதி தேடுக…"],
    useGps: ["Use my current location", "என் தற்போதைய இருப்பிடம்"],
    pickMap: ["Pick on map", "வரைபடத்தில் தேர்வு"],
    tapMap: ["Tap the map to place the pin", "இடத்தைத் தேர்வு செய்ய வரைபடத்தில் தொடவும்"],
    settings: ["Settings", "அமைப்புகள்"],
    enable: ["Turn on rain alarm", "மழை அலாரத்தை இயக்கு"],
    empty: ["Add your home, office or family town and get an alarm before the rain reaches.",
      "உங்கள் வீடு, அலுவலகம், சொந்த ஊரைச் சேர்த்து, மழை வருவதற்கு முன் அலாரம் பெறுங்கள்."],
    stale: ["IMD radar data is old", "IMD ரேடார் தரவு பழையது"],
    offline: ["Radar data not reachable", "ரேடார் தரவு கிடைக்கவில்லை"],
    outside: ["Outside IMD radar · RainViewer/model", "IMD ரேடாருக்கு வெளியே"],
    test: ["Test alarm", "சோதனை அலாரம்"],
    remove: ["Remove", "நீக்கு"],
  };
  const tx = (k) => {
    const v = T[k]; if (!v) return k;
    return S.lang === "en" ? v[0] : S.lang === "ta" ? v[1] : v[1];
  };
  const pname = (p) => (S.lang === "en" ? p.en : (p.ta || p.en));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel) => document.querySelector(sel);
  const INLINE = window.RA_INLINE_FILES || null;          // the single-file preview build carries its data inline
  const getJSON = (path) => INLINE && INLINE[path] ? Promise.resolve(INLINE[path]) : fetch(path).then((r) => r.json());

  /* ====================================================================== */
  /* map                                                                    */
  /* ====================================================================== */
  // The view stops at 24.5 N: the IMD radars this app reads are all in the
  // south, and no basemap border north of that is ever shown.
  const MAX_BOUNDS = L.latLngBounds([-4, 62], [24.5, 97]);
  const map = L.map("map", {
    zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 12,
    maxBounds: MAX_BOUNDS, maxBoundsViscosity: 1.0, worldCopyJump: false,
  }).setView([12.2, 79.2], 6);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  $("#zoom-in").addEventListener("click", () => map.zoomIn());
  $("#zoom-out").addEventListener("click", () => map.zoomOut());

  // basemaps: terrain (default, like rain-alarm), light street map, dark
  const BASES = {
    terrain: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri — Esri, HERE, Garmin, USGS, NGA", bounds: MAX_BOUNDS, maxNativeZoom: 12 }),
    light: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { subdomains: "abcd", attribution: "© OpenStreetMap · © CARTO", bounds: MAX_BOUNDS }),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { subdomains: "abcd", attribution: "© OpenStreetMap · © CARTO", bounds: MAX_BOUNDS }),
  };
  function applyTheme() {
    const key = BASES[S.basemap] ? S.basemap : "terrain";
    document.documentElement.dataset.theme = key === "dark" ? "dark" : "light";
    Object.entries(BASES).forEach(([k, ly]) => { if (k === key) ly.addTo(map); else map.removeLayer(ly); });
    const c = key === "dark" ? "#9aa3c7" : "#3c4256";
    if (boundaryLayer) boundaryLayer.setStyle({ color: c });
    if (ringLayer) ringLayer.setStyle({ color: key === "dark" ? "#c9cde0" : "#2b2f3d" });
  }
  map.createPane("rv"); map.getPane("rv").style.zIndex = 380;
  map.createPane("imd"); map.getPane("imd").style.zIndex = 390;
  map.createPane("lines"); map.getPane("lines").style.zIndex = 395; map.getPane("lines").style.pointerEvents = "none";

  // district lines + thin radar range rings (as on rain-alarm)
  let boundaryLayer = null, ringLayer = null;
  getJSON("data/boundaries.json").then((b) => {
    const lines = (b.districts || []).map((ring) => ring.map(([lo, la]) => [la, lo]));
    boundaryLayer = L.polyline(lines, { pane: "lines", color: S.basemap === "dark" ? "#9aa3c7" : "#3c4256", weight: 0.5, opacity: 0.45, interactive: false }).addTo(map);
  }).catch(() => {});
  getJSON("data/radars.json").then((rs) => {
    ringLayer = L.layerGroup((rs || []).map((r) =>
      L.circle([r.lat, r.lon], { radius: (r.range_km || 250) * 1000, pane: "lines", color: S.basemap === "dark" ? "#c9cde0" : "#2b2f3d",
        weight: 1, opacity: 0.55, fill: false, interactive: false }))).addTo(map);
    ringLayer.setStyle = (o) => ringLayer.eachLayer((l) => l.setStyle(o));
  }).catch(() => {});

  /* ---- colour lookup: dBZ (0..90, as float) -> rain-rate colour ---- */
  const LUT = (() => {
    const lut = new Uint8ClampedArray(91 * 4);
    for (let v = 1; v <= 90; v++) {
      const b = RA.band(v); if (!b) continue;
      const h = b.color;
      lut[v * 4] = parseInt(h.slice(1, 3), 16); lut[v * 4 + 1] = parseInt(h.slice(3, 5), 16);
      lut[v * 4 + 2] = parseInt(h.slice(5, 7), 16); lut[v * 4 + 3] = 235;
    }
    return lut;
  })();

  /* ---- IMD layer: grid -> smooth canvas (bilinear x3, Mercator-correct) -> image overlay ---- */
  const UP = 3;                           // upsampling: 2.2 km grid -> ~0.7 km pixels, smooth edges
  const IMD_MIN = 19.5;                   // IMD's weakest colour; below that the edge fades out
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  const imgCache = new Map();
  function imdImage(g, frame) {
    if (imgCache.has(frame.bytes)) return imgCache.get(frame.bytes);
    const W = g.ncols * UP, H = g.nrows * UP, NC = g.ncols, NR = g.nrows, B = frame.bytes;
    const north = g.lat_north + g.step_deg / 2, south = g.lat_north - (g.nrows - 0.5) * g.step_deg;
    const yN = mercY(north), yS = mercY(south);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), id = ctx.createImageData(W, H), d = id.data;
    const val = (r, c) => { const v = B[r * NC + c]; return v === 255 ? 0 : v; };
    for (let j = 0; j < H; j++) {
      const lat = invMercY(yN + (yS - yN) * (j + 0.5) / H);
      const fr = Math.min(NR - 1.001, Math.max(0, (g.lat_north - lat) / g.step_deg));
      const r0 = Math.floor(fr), wr = fr - r0;
      for (let i = 0; i < W; i++) {
        const fc = Math.min(NC - 1.001, Math.max(0, (i + 0.5) / UP - 0.5));
        const c0 = Math.floor(fc), wc = fc - c0;
        const a = val(r0, c0), b = val(r0, c0 + 1), c = val(r0 + 1, c0), e = val(r0 + 1, c0 + 1);
        if (!(a | b | c | e)) continue;
        const v = (a * (1 - wc) + b * wc) * (1 - wr) + (c * (1 - wc) + e * wc) * wr;
        if (v < IMD_MIN) continue;
        const o = (j * W + i) * 4, l = Math.min(90, Math.round(Math.max(v, 20))) * 4;
        d[o] = LUT[l]; d[o + 1] = LUT[l + 1]; d[o + 2] = LUT[l + 2]; d[o + 3] = LUT[l + 3];
      }
    }
    ctx.putImageData(id, 0, 0);
    const url = cv.toDataURL("image/png");
    imgCache.set(frame.bytes, url);
    return url;
  }
  function imdBounds(g) {
    return L.latLngBounds([g.lat_north - (g.nrows - 0.5) * g.step_deg, g.lon_west - g.step_deg / 2],
      [g.lat_north + g.step_deg / 2, g.lon_west + (g.ncols - 0.5) * g.step_deg]);
  }
  let imdOverlay = null;

  /* ---- RainViewer (past 2 h, zoom <= 7, personal/educational use) ----
   * Tiles are repainted in the same mm/h colours as IMD, so the two radars
   * read as one picture. If the browser will not let us read a tile, the
   * original RainViewer colours are shown instead. */
  const RV = { host: null, frames: [], layers: new Map(), ok: false, sampleOk: true };
  async function loadRainViewer() {
    try {
      const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" })).json();
      RV.host = j.host; RV.frames = ((j.radar && j.radar.past) || []).map((f) => ({ time: new Date(f.time * 1000), path: f.path }));
      RV.ok = RV.frames.length > 0;
      const live = new Set(RV.frames.map((f) => f.path));          // drop frames that left the 2 h window
      RV.layers.forEach((ly, path) => { if (!live.has(path)) { map.removeLayer(ly); RV.layers.delete(path); } });
      tileCache.forEach((v, k) => { if (!live.has(k.split("/").slice(0, -3).join("/"))) tileCache.delete(k); });
    } catch (e) { RV.ok = false; }
  }
  const rvColorCache = new Map();
  const RecolorLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas"); tile.width = tile.height = 256;
      const im = new Image(); im.crossOrigin = "anonymous";
      im.onload = () => {
        const cx = tile.getContext("2d");
        cx.drawImage(im, 0, 0);
        try {
          const id = cx.getImageData(0, 0, 256, 256), d = id.data;
          for (let o = 0; o < d.length; o += 4) {
            if (d[o + 3] < 60) { d[o + 3] = 0; continue; }
            const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
            let l = rvColorCache.get(key);
            if (l === undefined) { const z = rvDbz(d[o], d[o + 1], d[o + 2], 255); l = z > 0 ? Math.min(90, z) * 4 : -1; rvColorCache.set(key, l); }
            if (l < 0 || !LUT[l + 3]) { d[o + 3] = 0; continue; }
            d[o] = LUT[l]; d[o + 1] = LUT[l + 1]; d[o + 2] = LUT[l + 2]; d[o + 3] = LUT[l + 3];
          }
          cx.putImageData(id, 0, 0);
        } catch (e) { /* tile not readable: keep RainViewer's own colours */ }
        done(null, tile);
      };
      im.onerror = () => done(null, tile);
      im.src = this.getTileUrl(coords);
      return tile;
    },
  });
  function rvLayer(f) {
    if (!RV.layers.has(f.path)) {
      RV.layers.set(f.path, new RecolorLayer(`${RV.host}${f.path}/256/{z}/{x}/{y}/2/1_0.png`, {
        pane: "rv", opacity: 0, maxNativeZoom: 7, maxZoom: 12, bounds: MAX_BOUNDS,
        attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
      }));
    }
    return RV.layers.get(f.path);
  }
  // Universal Blue colour table (rain), dBZ 10..70 -- used to read tiles back into dBZ
  const RV_TABLE = "087fdb0c73dd1068e0145de21852e51c47e82c3be13c2fda4d24d35d18cc6e0dc6800db9920daca40e9fb60e92c80f86c62086c43186c34286c15386c06487c36b77c77268ca7959ce804ad2883bda9439e2a037eaac35f2b833fac431facf27fbda1efce514fdf00bfefb02fee713fed424fec035fead46fe9a58fe8e47fe8236fe7626fe6a15fe5f05fd5609fd4d0efd4512fd3c17fd341cf04f3ce36b5cd7867dcaa29dbebebec2c2c2c6c6c6cacacacececed3d3d3"
    .match(/.{6}/g).map((h, i) => [10 + i, parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
  function rvDbz(r, g, b, a) {
    if (a < 60) return 0;
    let best = 0, bd = 1e9;
    for (const [z, R, G, B] of RV_TABLE) { const dd = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (dd < bd) { bd = dd; best = z; } }
    return bd < 3000 ? best : 0;
  }
  const tileCache = new Map();
  function rvTile(f, x, y, z) {
    const key = `${f.path}/${z}/${x}/${y}`;
    if (!tileCache.has(key)) {
      tileCache.set(key, new Promise((res) => {
        const im = new Image(); im.crossOrigin = "anonymous";
        im.onload = () => {
          try {
            const c = document.createElement("canvas"); c.width = c.height = 256;
            const cx = c.getContext("2d"); cx.drawImage(im, 0, 0);
            res(cx.getImageData(0, 0, 256, 256).data);
          } catch (e) { RV.sampleOk = false; res(null); }
        };
        im.onerror = () => res(null);
        im.src = `${RV.host}${f.path}/256/${z}/${x}/${y}/2/0_0.png`;
      }));
    }
    return tileCache.get(key);
  }
  // nearest echo >= thr within maxKm on one RainViewer frame (zoom 7 ~ 1.2 km/px)
  async function rvNearest(f, lat, lon, maxKm, thr) {
    const z = 7, n = 256 * 2 ** z;
    const px = (lon + 180) / 360 * n;
    const s = Math.sin(lat * Math.PI / 180), py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const kmPx = 40075 * Math.cos(lat * Math.PI / 180) / n, rad = Math.ceil(maxKm / kmPx);
    const tiles = new Map();
    for (let ty = Math.floor((py - rad) / 256); ty <= Math.floor((py + rad) / 256); ty++)
      for (let tx2 = Math.floor((px - rad) / 256); tx2 <= Math.floor((px + rad) / 256); tx2++)
        tiles.set(`${tx2},${ty}`, await rvTile(f, tx2, ty, z));
    let best = null, nowMax = 0, nowSecond = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy) * kmPx; if (d > maxKm) continue;
        const X = Math.floor(px + dx), Y = Math.floor(py + dy);
        const t = tiles.get(`${Math.floor(X / 256)},${Math.floor(Y / 256)}`); if (!t) continue;
        const o = ((Y & 255) * 256 + (X & 255)) * 4, v = rvDbz(t[o], t[o + 1], t[o + 2], t[o + 3]);
        if (d <= 3) { if (v > nowMax) { nowSecond = nowMax; nowMax = v; } else if (v > nowSecond) nowSecond = v; }
        if (v >= thr && (!best || d < best.km)) best = { km: d, brg: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, dbz: v };
      }
    }
    return { best, now: nowSecond };
  }
  async function evaluateRv(place, s) {
    if (!RV.ok || !RV.sampleOk || RV.frames.length < 3) return null;
    const last = RV.frames[RV.frames.length - 1];
    const prev = RV.frames[Math.max(0, RV.frames.length - 4)];      // ~30 min earlier
    const a = await rvNearest(last, place.lat, place.lon, 60, s.thr);
    if (!RV.sampleOk) return null;
    const res = { src: "rv", now: a.now, strip: [], eta: null, end: null, peak: 0, near: null };
    if (a.best) {
      const b = await rvNearest(prev, place.lat, place.lon, 60, s.thr);
      const dt = (last.time - prev.time) / 3600000;
      let approaching = null, speed = null;
      if (b.best && dt > 0) {
        speed = (b.best.km - a.best.km) / dt;                        // closing speed, km/h
        approaching = speed > 4;
        if (approaching && a.now < s.thr) {
          const eta = Math.round(a.best.km / speed * 60 / 5) * 5;
          if (eta <= s.windowMin) { res.eta = Math.max(5, eta); res.peak = a.best.dbz; }
        }
      }
      res.near = Object.assign(a.best, { approaching, speed });
    }
    res.level = RA.levelOf(res, s);
    return res;
  }

  /* ====================================================================== */
  /* timeline: past loop + now + nowcast                                    */
  /* ====================================================================== */
  let imd = null, frames = [], fi = 0, playing = false, playTimer = null;
  function buildFrames() {
    frames = [];
    const useImd = imd && imd.g && S.source !== "rv";
    const useRv = RV.ok && S.source !== "imd";
    if (useImd) {
      imd.history.forEach((h) => frames.push({ time: h.time, imd: h, kind: "past" }));
      imd.layers.forEach((L0) => frames.push({ time: L0.time, imd: L0, kind: L0.lead ? "future" : "now" }));
    } else if (useRv) {
      RV.frames.forEach((f, i) => frames.push({ time: f.time, kind: i === RV.frames.length - 1 ? "now" : "past" }));
    }
    if (useRv) {                              // attach the nearest RainViewer frame (past/now only)
      for (const fr of frames) {
        if (fr.kind === "future") continue;
        let best = null;
        for (const f of RV.frames) if (!best || Math.abs(f.time - fr.time) < Math.abs(best.time - fr.time)) best = f;
        if (best && Math.abs(best.time - fr.time) <= 15 * 60000) fr.rv = best;
      }
      // preload so the loop does not flicker
      new Set(frames.map((f) => f.rv).filter(Boolean)).forEach((f) => rvLayer(f).addTo(map));
    }
    const slider = $("#tl-slider");
    slider.max = Math.max(0, frames.length - 1);
    fi = Math.max(0, frames.findIndex((f) => f.kind === "now"));
    slider.value = fi;
    // colour the forecast part of the track
    const nowIdx = fi, tot = Math.max(1, frames.length - 1);
    slider.style.setProperty("--now", (nowIdx / tot * 100).toFixed(1) + "%");
    showFrame(fi);
  }
  function showFrame(i) {
    fi = i;
    const fr = frames[i]; if (!fr) return;
    if (fr.imd && imd && imd.g) {
      const url = imdImage(imd.g, fr.imd);
      if (!imdOverlay) imdOverlay = L.imageOverlay(url, imdBounds(imd.g), { pane: "imd", opacity: 0.9, interactive: false }).addTo(map);
      else { imdOverlay.setUrl(url); if (!map.hasLayer(imdOverlay)) imdOverlay.addTo(map); }
    } else if (imdOverlay) map.removeLayer(imdOverlay);
    RV.layers.forEach((ly, path) => ly.setOpacity(fr.rv && fr.rv.path === path ? 0.85 : 0));
    const mins = Math.round((fr.time - (frames.find((f) => f.kind === "now") || fr).time) / 60000);
    const clock = RA.clockIST(fr.time);
    const lab = fr.kind === "now" ? tx("now") : (mins > 0 ? `+${mins} min` : `${mins} min`);
    $("#tl-time").innerHTML = `<b>${esc(lab)}</b> <span>${esc(clock)}</span>` +
      (fr.kind === "future" ? ` <em class="fc">${esc(tx("forecast"))}</em>` : "");
    $("#tl-slider").value = i;
    $("#tl-clock").textContent = hhmm(fr.time);
    $("#tl-tag").textContent = fr.kind === "now" ? tx("now") : fr.kind === "future" ? `+${mins} min · ${tx("forecast")}` : `${mins} min`;
    document.body.classList.toggle("is-future", fr.kind === "future");
  }
  function play(on) {
    playing = on; $("#tl-play").classList.toggle("on", on);
    $("#tl-play").setAttribute("aria-label", on ? "Pause" : "Play");
    clearTimeout(playTimer);
    if (!on) return;
    const tick = () => {
      const next = (fi + 1) % frames.length;
      showFrame(next);
      playTimer = setTimeout(tick, frames[next] && frames[next].kind === "now" ? 1400 : next === frames.length - 1 ? 1600 : 450);
    };
    playTimer = setTimeout(tick, 300);
  }
  const hhmm = (d) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(d);
  $("#tl-play").addEventListener("click", () => play(!playing));
  $("#tl-back").addEventListener("click", () => { play(false); showFrame((fi - 1 + frames.length) % frames.length); });
  $("#tl-now").addEventListener("click", () => { play(false); showFrame(Math.max(0, frames.findIndex((f) => f.kind === "now"))); });
  $("#tl-slider").addEventListener("input", (e) => { play(false); showFrame(+e.target.value); });

  /* ====================================================================== */
  /* places                                                                 */
  /* ====================================================================== */
  let townList = [];
  getJSON("data/places.json").then((j) => { townList = j; }).catch(() => {});
  const markers = new Map();
  const results = new Map();          // place id -> evaluation
  let gpsPlace = null;

  function placeIcon(level) {
    return L.divIcon({ className: "pin pin-l" + level, html: "<i></i>", iconSize: [22, 22], iconAnchor: [11, 11] });
  }
  function drawMarkers() {
    const all = gpsPlace ? [gpsPlace, ...places] : places;
    const ids = new Set(all.map((p) => p.id));
    markers.forEach((m, id) => { if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); } });
    for (const p of all) {
      const r = results.get(p.id), lvl = r ? r.level : 0;
      let m = markers.get(p.id);
      if (!m) { m = L.marker([p.lat, p.lon], { icon: placeIcon(lvl), keyboard: false }).addTo(map); markers.set(p.id, m); }
      else { m.setLatLng([p.lat, p.lon]); m.setIcon(placeIcon(lvl)); }
      m.bindTooltip(esc(pname(p)), { direction: "top", offset: [0, -10], className: "pin-tip", permanent: all.length <= 4 });
    }
  }

  function stripHtml(r) {
    if (!r || !r.strip.length) return "";
    const cells = r.strip.filter((x) => x.lead <= Math.max(S.windowMin, 60)).map((x) => {
      const b = x.dbz > 0 ? RA.band(x.dbz) : null;
      const cls = x.dbz < 0 ? "na" : b ? "" : "dry";
      return `<i class="${cls}" style="${b ? `background:${b.color}` : ""}" title="+${x.lead} min"></i>`;
    }).join("");
    return `<div class="strip" aria-hidden="true">${cells}</div><div class="strip-ax"><span>${esc(tx("now"))}</span><span>+${Math.max(S.windowMin, 60)} min</span></div>`;
  }

  function renderPlaces() {
    const list = $("#place-list");
    const all = gpsPlace ? [gpsPlace, ...places] : places;
    if (!all.length) {
      list.innerHTML = `<div class="empty"><p>${esc(tx("empty"))}</p>
        <button class="btn primary" data-act="add">＋ ${esc(tx("add"))}</button></div>`;
      return;
    }
    list.innerHTML = all.map((p) => {
      const r = results.get(p.id), lvl = r ? r.level : -1;
      const d = RA.describe(r, p, S);
      const line = S.lang === "en" ? esc(d.en) : S.lang === "ta" ? esc(d.ta) : `${esc(d.ta)}<small>${esc(d.en)}</small>`;
      const sub = S.lang === "both" && p.ta && p.ta !== p.en ? `<span class="pn-sub">${esc(S.lang === "en" ? p.ta : p.en)}</span>` : "";
      const chip = lvl === 3 ? "🌧️" : lvl === 2 ? "⏰" : lvl === 1 ? "☁️" : lvl === 0 ? "☀️" : "…";
      return `<article class="pcard lvl${lvl}" data-id="${esc(p.id)}">
        <div class="pc-top"><span class="chip">${chip}</span>
          <div class="pn"><b>${esc(pname(p))}</b>${sub}</div>
          ${p.gps ? `<span class="tag">📍 ${esc(tx("myLoc"))}</span>` : `<button class="x" data-act="del" aria-label="${esc(tx("remove"))}">✕</button>`}
        </div>
        <p class="pc-line">${line}</p>
        ${stripHtml(r)}
      </article>`;
    }).join("") + `<button class="btn add-more" data-act="add">＋ ${esc(tx("add"))}</button>`;
  }
  $("#place-list").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    const card = e.target.closest(".pcard");
    if (act && act.dataset.act === "add") return openAdd();
    if (act && act.dataset.act === "del" && card) {
      places = places.filter((p) => p.id !== card.dataset.id); savePlaces();
      results.delete(card.dataset.id); drawMarkers(); renderPlaces(); return;
    }
    if (card) {
      const p = (gpsPlace && gpsPlace.id === card.dataset.id) ? gpsPlace : places.find((x) => x.id === card.dataset.id);
      if (p) { map.flyTo([p.lat, p.lon], 9, { duration: 0.8 }); setSheet("peek"); }
    }
  });

  /* ---- add place dialog ---- */
  const addDlg = $("#add-dlg");
  function openAdd() { addDlg.classList.add("open"); $("#add-q").value = ""; $("#add-res").innerHTML = suggestHtml(""); setTimeout(() => $("#add-q").focus(), 50); }
  function closeAdd() { addDlg.classList.remove("open"); }
  $("#add-close").addEventListener("click", closeAdd);
  function addPlace(p) {
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    places.push({ id, en: p.en, ta: p.ta || "", lat: +(+p.lat).toFixed(4), lon: +(+p.lon).toFixed(4) });
    savePlaces(); closeAdd(); drawMarkers(); renderPlaces(); evaluateAll(false);
    map.flyTo([p.lat, p.lon], 9, { duration: 0.8 });
  }
  function suggestHtml(q) {
    const ql = q.trim().toLowerCase();
    const hits = (ql ? townList.filter((t) => t.en.toLowerCase().includes(ql) || (t.ta || "").includes(q.trim())) : townList.filter((t) => t.p === 1))
      .slice(0, ql ? 12 : 30);
    return hits.map((t) => `<button class="res" data-lat="${t.lat}" data-lon="${t.lon}" data-en="${esc(t.en)}" data-ta="${esc(t.ta)}">
      <b>${esc(t.en)}</b><span>${esc(t.ta)}</span></button>`).join("");
  }
  let qTimer = null;
  $("#add-q").addEventListener("input", (e) => {
    const q = e.target.value;
    $("#add-res").innerHTML = suggestHtml(q);
    clearTimeout(qTimer);
    if (q.trim().length < 3) return;
    qTimer = setTimeout(async () => {
      try {
        const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=8&language=en&countryCode=IN`;
        const j = await (await fetch(u)).json();
        const extra = (j.results || []).filter((r) => MAX_BOUNDS.contains([r.latitude, r.longitude])).map((r) =>
          `<button class="res" data-lat="${r.latitude}" data-lon="${r.longitude}" data-en="${esc(r.name)}" data-ta="">
            <b>${esc(r.name)}</b><span>${esc([r.admin2, r.admin1].filter(Boolean).join(", "))}</span></button>`).join("");
        if ($("#add-q").value === q) $("#add-res").innerHTML = suggestHtml(q) + extra;
      } catch (err) { /* offline */ }
    }, 350);
  });
  $("#add-res").addEventListener("click", (e) => {
    const b = e.target.closest(".res"); if (!b) return;
    addPlace({ en: b.dataset.en, ta: b.dataset.ta, lat: b.dataset.lat, lon: b.dataset.lon });
  });
  $("#add-gps").addEventListener("click", () => {
    locate(true).then((p) => { if (p) addPlace({ en: "Home", ta: "வீடு", lat: p.lat, lon: p.lon }); });
  });
  let picking = false;
  $("#add-pick").addEventListener("click", () => { closeAdd(); picking = true; toast(tx("tapMap")); document.body.classList.add("picking"); setSheet("peek"); });
  map.on("click", (e) => {
    if (!picking) return;
    picking = false; document.body.classList.remove("picking");
    // name the pin after the nearest town in the list (or its coordinates)
    let near = null, nd = 1e9;
    for (const t of townList) { const d = RA.distKm(e.latlng.lat, e.latlng.lng, t.lat, t.lon); if (d < nd) { nd = d; near = t; } }
    const coord = `${e.latlng.lat.toFixed(2)}, ${e.latlng.lng.toFixed(2)}`;
    const en = near && nd < 4 ? near.en : near && nd < 25 ? `Near ${near.en}` : coord;
    const ta = near && nd < 4 ? near.ta : near && nd < 25 ? `${near.ta} அருகில்` : coord;
    addPlace({ en, ta, lat: e.latlng.lat, lon: e.latlng.lng });
  });

  /* ---- GPS ---- */
  function locate(fly) {
    return new Promise((res) => {
      if (!navigator.geolocation) { res(null); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const p = { id: "gps", gps: true, en: T.myLoc[0], ta: T.myLoc[1], lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (!MAX_BOUNDS.contains([p.lat, p.lon])) { toast("Outside the radar map area"); res(null); return; }
        gpsPlace = p; drawMarkers(); renderPlaces(); evaluateAll(false); updateWeather();
        if (fly) map.flyTo([p.lat, p.lon], 9);
        res(p);
      }, () => { toast(S.lang === "en" ? "Location permission denied" : "இருப்பிட அனுமதி இல்லை"); res(null); },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
    });
  }
  $("#btn-locate").addEventListener("click", () => locate(true));

  /* ====================================================================== */
  /* alarm                                                                  */
  /* ====================================================================== */
  let audioCtx = null, alarmTimer = null, alarmLines = [];
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  function chime(rounds) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + 0.05;
    const notes = [659, 784, 988, 784, 988, 1319];
    for (let r = 0; r < rounds; r++) {
      notes.forEach((f, i) => {
        const t = t0 + r * 1.6 + i * 0.17;
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "triangle"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.18);
      });
    }
  }
  const inQuiet = () => { const h = +new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()); return S.quiet && (h >= 23 || h < 6); };

  function shouldFire(p, r) {
    const minLvl = S.near ? 1 : 2;
    const prev = alertLog[p.id];
    const now = Date.now();
    if (r.level < minLvl) {
      // clear for 30 min -> the next storm counts as a new event
      if (prev && r.level === 0 && now - prev.at > 30 * 60000) delete alertLog[p.id];
      return false;
    }
    if (r.level === 1 && !(r.near && r.near.approaching)) return false;
    const peak = Math.max(r.now, r.peak || 0, r.near ? r.near.dbz : 0);
    if (!prev) return true;
    if (now - prev.at > 90 * 60000) return true;                     // long gap -> new event
    if (r.level > prev.level) return true;                           // coming -> raining now
    if (RA.tier(peak) && RA.tier(prev.dbz) && RA.tier(peak).min >= 40 && RA.tier(peak).min > RA.tier(prev.dbz).min) return true;  // got heavier
    return false;
  }
  async function fireAlarm(p, r, test) {
    const peak = Math.max(r.now, r.peak || 0, r.near ? r.near.dbz : 0);
    if (!test) { alertLog[p.id] = { level: r.level, at: Date.now(), dbz: peak }; store.set("alerts", alertLog); mirrorToWorker(); }
    const d = RA.describe(r, p, S);
    const title = RA.alarmTitle(r, p, S.lang === "en" ? "en" : "ta");
    const body = S.lang === "en" ? d.en : S.lang === "ta" ? d.ta : `${d.ta}\n${d.en}`;
    // in-app banner (several places in one cycle are listed together)
    const wasOpen = $("#alarm").classList.contains("open");
    if (!wasOpen) alarmLines = [];
    alarmLines.push({ title, body: `${pname(p)} — ${body}`, peak });
    const top = alarmLines.reduce((a, x) => (x.peak > a.peak ? x : a));
    $("#alarm-title").textContent = alarmLines.length === 1 ? title
      : (S.lang === "en" ? `⏰ Rain alert · ${alarmLines.length} places` : `⏰ ${alarmLines.length} இடங்களில் மழை எச்சரிக்கை`);
    $("#alarm-body").textContent = alarmLines.length === 1 ? body : alarmLines.map((x) => x.body).join("\n\n");
    $("#alarm").classList.add("open");
    const b = RA.band(Math.max(top.peak, 20));
    $("#alarm").style.setProperty("--ac", b ? b.color : "#00A8FF");
    if (wasOpen) { /* already ringing */ } else if (S.sound && !inQuiet()) { unlockAudio(); chime(3); clearInterval(alarmTimer); let n = 0; alarmTimer = setInterval(() => { if (++n > 3) return clearInterval(alarmTimer); chime(2); }, 5200); }
    if (!wasOpen && S.vibrate && navigator.vibrate && !inQuiet()) navigator.vibrate([500, 200, 500, 200, 900]);
    // system notification (shows even when the tab is in the background)
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const reg = await navigator.serviceWorker.getRegistration();
        const opt = { body, tag: "ra-" + p.id, renotify: true, icon: "icons/icon-192.png", badge: "icons/badge-96.png",
          vibrate: S.vibrate && !inQuiet() ? [500, 200, 500, 200, 900] : [], requireInteraction: r.level >= 2, data: { url: location.href } };
        if (reg) reg.showNotification(title, opt); else new Notification(title, opt);
      }
    } catch (e) { /* ignore */ }
  }
  $("#alarm-stop").addEventListener("click", () => { $("#alarm").classList.remove("open"); clearInterval(alarmTimer); if (navigator.vibrate) navigator.vibrate(0); });

  /* ====================================================================== */
  /* data refresh + evaluation                                              */
  /* ====================================================================== */
  let lastLoad = 0, loading = false;
  async function evaluatePlace(p) {
    const s = { thr: S.thr, windowMin: S.windowMin };
    let r = imd ? RA.evaluateImd(imd, p, s) : null;
    if (!r) { try { r = await evaluateRv(p, s); } catch (e) { r = null; } }
    if (!r || (r.src === "rv" && r.level === 0)) {
      try { const m = await RA.evaluateModel(p, s); if (!r || m.level > 0) r = m; } catch (e) { /* offline */ }
    }
    return r;
  }
  async function evaluateAll(allowAlarm) {
    const all = gpsPlace ? [gpsPlace, ...places] : places;
    for (const p of all) {
      const r = await evaluatePlace(p);
      if (r) results.set(p.id, r);
      if (r && allowAlarm && S.onboarded && S.alarmOn && shouldFire(p, r)) await fireAlarm(p, r, false);
    }
    store.set("alerts", alertLog);
    drawMarkers(); renderPlaces();
  }
  function setStatus() {
    const el = $("#status");
    if (!imd || !imd.g) { el.className = "status bad"; el.innerHTML = `<i></i>${esc(RV.ok ? "RainViewer" : tx("offline"))}`; return; }
    const age = Math.round(RA.imdAgeMin(imd));
    const fresh = RA.imdFresh(imd);
    el.className = "status " + (fresh ? "ok" : "bad");
    const when = RA.clockIST(new Date(imd.doc.generated_utc));
    el.innerHTML = `<i></i>IMD ${esc(when)} · ${age < 1 ? (S.lang === "en" ? "just now" : "இப்போது") : age + (S.lang === "en" ? " min ago" : " நிமி முன்")}` + (imd.doc.demo ? " · DEMO" : "");
    el.title = fresh ? "" : tx("stale");
  }
  async function refresh(allowAlarm) {
    if (loading) return; loading = true;
    try {
      const [a] = await Promise.all([RA.loadImd().catch(() => null), loadRainViewer()]);
      if (a && a.g) {
        const changed = !imd || imd.doc.version !== a.doc.version;
        if (changed) { imgCache.clear(); imd = await RA.loadImdHistory(a); }
      } else if (a) imd = a;
      lastLoad = Date.now();
      buildFrames();
      setStatus();
      await evaluateAll(allowAlarm);
    } finally { loading = false; }
  }
  setInterval(setStatus, 30000);
  setInterval(() => { if (Date.now() - lastLoad > 4.5 * 60000) refresh(true); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastLoad > 2 * 60000) refresh(true); });

  /* ====================================================================== */
  /* bottom sheet, settings, legend, onboarding                             */
  /* ====================================================================== */
  const sheet = $("#sheet");
  function setSheet(state) { sheet.dataset.state = state; }
  $("#sheet-handle").addEventListener("click", () => setSheet(sheet.dataset.state === "full" ? "peek" : "full"));
  let dragY = null;
  $("#sheet-handle").addEventListener("touchstart", (e) => { dragY = e.touches[0].clientY; }, { passive: true });
  $("#sheet-handle").addEventListener("touchend", (e) => {
    if (dragY === null) return;
    const dy = e.changedTouches[0].clientY - dragY; dragY = null;
    if (dy < -30) setSheet("full"); else if (dy > 30) setSheet("peek");
  });

  function renderLegend() {
    $("#scale").innerHTML = `<span class="u">mm/h &gt;</span>` + RA.BANDS.map((b) =>
      `<span class="c" style="--c:${b.color}" title="${esc(S.lang === "en" ? b.en : b.ta)}">${b.mm}</span>`).join("");
  }

  function seg(name, opts, val) {
    return `<div class="seg" data-name="${name}">` + opts.map(([v, l]) =>
      `<button data-v="${v}" class="${String(v) === String(val) ? "on" : ""}">${esc(l)}</button>`).join("") + "</div>";
  }
  const sw = (name, val, label) => `<label class="sw"><span>${esc(label)}</span><input type="checkbox" data-name="${name}" ${val ? "checked" : ""}><i></i></label>`;
  function renderSettings() {
    const en = S.lang === "en";
    $("#set-body").innerHTML = `
      <h4>${en ? "Language" : "மொழி"}</h4>${seg("lang", [["ta", "தமிழ்"], ["both", "தமிழ் + English"], ["en", "English"]], S.lang)}
      <h4>${en ? "Alarm me for" : "எந்த மழைக்கு அலாரம்"}</h4>${seg("thr", [[20, en ? "Any rain" : "எல்லா மழை"], [30, en ? "Moderate+" : "மிதமான+"], [40, en ? "Heavy only" : "கனமழை மட்டும்"]], S.thr)}
      <h4>${en ? "Warn me ahead by" : "எவ்வளவு முன்பே"}</h4>${seg("windowMin", [[30, "30 min"], [60, "60 min"], [90, "90 min"]], S.windowMin)}
      <h4>${en ? "Map" : "வரைபடம்"}</h4>${seg("basemap", [["terrain", en ? "Terrain" : "நிலப்பரப்பு"], ["light", en ? "Streets" : "தெருக்கள்"], ["dark", en ? "Dark" : "இருண்ட"]], S.basemap)}
      <h4>${en ? "Radar on map" : "வரைபட ரேடார்"}</h4>${seg("source", [["imd", "IMD"], ["both", en ? "IMD + RainViewer" : "IMD + RainViewer"], ["rv", "RainViewer"]], S.source)}
      <div class="sws">
        ${sw("sound", S.sound, en ? "Alarm sound" : "அலாரம் ஒலி")}
        ${sw("vibrate", S.vibrate, en ? "Vibrate" : "அதிர்வு")}
        ${sw("near", S.near, en ? "Also alert when a storm is close & approaching" : "மழை மேகம் அருகில் நெருங்கினாலும் எச்சரிக்கை")}
        ${sw("quiet", S.quiet, en ? "Quiet hours 11 PM – 6 AM (silent)" : "இரவு 11 – காலை 6 அமைதி")}
      </div>
      <div class="set-actions">
        <button class="btn" id="btn-test">🔔 ${esc(tx("test"))}</button>
        <button class="btn" id="btn-perm">${esc(tx("enable"))}</button>
      </div>
      <p class="fine">${en
        ? "Radar: IMD Doppler radars via MasRainman nowcast (updates every 10 min). Outside IMD coverage: RainViewer (past 2 h) and Open-Meteo model. Nowcast moves today's rain along its measured track — storms can grow or die, so treat times as a guide."
        : "ரேடார்: IMD டாப்ளர் ரேடார் — MasRainman நவ்காஸ்ட் (10 நிமிடத்துக்கு ஒருமுறை). IMD வரம்புக்கு வெளியே RainViewer, Open-Meteo. மழை மேகங்கள் வளரலாம் / கலையலாம் — நேரங்கள் வழிகாட்டுதல் மட்டுமே."}</p>`;
  }
  $("#set-body").addEventListener("click", (e) => {
    const b = e.target.closest(".seg button");
    if (b) {
      const name = b.parentElement.dataset.name, v = b.dataset.v;
      S[name] = isNaN(+v) ? v : +v; saveSettings(); renderAll();
      if (name === "thr" || name === "windowMin") evaluateAll(false);
      if (name === "source") buildFrames();
      if (name === "basemap") applyTheme();
      return;
    }
    if (e.target.id === "btn-test") {
      unlockAudio();
      const p = places[0] || gpsPlace || { id: "test", en: "Chennai", ta: "சென்னை", lat: 13.08, lon: 80.27 };
      fireAlarm(p, { level: 2, now: 0, eta: 20, peak: 42, src: "imd", strip: [], near: null }, true);
    }
    if (e.target.id === "btn-perm") enableAlarm();
  });
  $("#set-body").addEventListener("change", (e) => {
    const i = e.target.closest("input[data-name]"); if (!i) return;
    S[i.dataset.name] = i.checked; saveSettings();
  });
  $("#btn-settings").addEventListener("click", () => { renderSettings(); $("#set-dlg").classList.add("open"); });
  $("#set-close").addEventListener("click", () => $("#set-dlg").classList.remove("open"));
  $("#btn-lang").addEventListener("click", () => { S.lang = S.lang === "en" ? "ta" : S.lang === "ta" ? "both" : "en"; saveSettings(); renderAll(); });

  function renderPower() {
    $("#btn-power").classList.toggle("on", !!S.alarmOn);
    $("#btn-power").title = S.alarmOn ? (S.lang === "en" ? "Rain alarm on" : "மழை அலாரம் இயக்கத்தில்") : (S.lang === "en" ? "Rain alarm off" : "மழை அலாரம் நிறுத்தம்");
  }
  $("#btn-power").addEventListener("click", () => {
    if (!S.onboarded) return enableAlarm();
    S.alarmOn = !S.alarmOn; saveSettings(); renderPower();
    toast(S.alarmOn ? (S.lang === "en" ? "Rain alarm on" : "மழை அலாரம் இயங்குகிறது") : (S.lang === "en" ? "Rain alarm off" : "மழை அலாரம் நிறுத்தப்பட்டது"));
    if (S.alarmOn) { unlockAudio(); evaluateAll(true); }
  });
  $("#btn-refresh").addEventListener("click", () => { $("#btn-refresh").classList.add("spin"); refresh(true).finally(() => setTimeout(() => $("#btn-refresh").classList.remove("spin"), 400)); });
  async function enableAlarm() {
    unlockAudio();
    try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) { /* ignore */ }
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg && "periodicSync" in reg) {
        const st = await navigator.permissions.query({ name: "periodic-background-sync" });
        if (st.state === "granted") await reg.periodicSync.register("ra-check", { minInterval: 15 * 60000 });
      }
    } catch (e) { /* not supported */ }
    S.onboarded = true; S.alarmOn = true; saveSettings(); renderPower();
    $("#onboard").classList.remove("open");
    if (!places.length) locate(true); else evaluateAll(true);
    if (EMBEDDED && !INLINE) toast(S.lang === "en" ? "For phone notifications, tap ↗ to open the full app" : "அறிவிப்புகளுக்கு ↗ தட்டி முழு செயலியைத் திறக்கவும்");
    else toast(S.lang === "en" ? "Rain alarm is on — keep this app open for instant alarms" : "மழை அலாரம் இயங்குகிறது");
  }
  $("#onboard-go").addEventListener("click", enableAlarm);
  $("#onboard-skip").addEventListener("click", () => { S.onboarded = true; saveSettings(); $("#onboard").classList.remove("open"); });
  document.addEventListener("pointerdown", unlockAudio, { once: true });

  let toastT = null;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("open"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("open"), 3200); }

  function renderAll() {
    document.documentElement.lang = S.lang === "en" ? "en" : "ta";
    $("#ttl").textContent = tx("title");
    $("#sheet-title").textContent = tx("myPlaces");
    $("#add-title").textContent = tx("add");
    $("#add-q").placeholder = tx("search");
    $("#add-gps").textContent = "📍 " + tx("useGps");
    $("#add-pick").textContent = "🗺️ " + tx("pickMap");
    $("#set-title").textContent = tx("settings");
    $("#alarm-stop").textContent = tx("stop");
    $("#btn-lang").textContent = S.lang === "en" ? "EN" : S.lang === "ta" ? "த" : "த/EN";
    renderLegend(); renderPlaces(); setStatus(); drawMarkers(); renderPower();
    if (frames.length) showFrame(fi);
  }

  /* ---- current weather chip (Open-Meteo) for my location / first place ---- */
  const WX = [[0, "☀️"], [1, "🌤️"], [3, "☁️"], [45, "🌫️"], [51, "🌦️"], [61, "🌧️"], [80, "🌦️"], [95, "⛈️"]];
  async function updateWeather() {
    const p = gpsPlace || places[0]; if (!p) return;
    try {
      const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lon.toFixed(3)}&current=temperature_2m,weather_code&timezone=auto`)).json();
      const c = j.current; if (!c) return;
      let icon = "☁️"; for (const [code, ic] of WX) if (c.weather_code >= code) icon = ic;
      $("#wx-t").textContent = Math.round(c.temperature_2m) + "°";
      $("#wx-i").textContent = icon;
      $("#wx").title = pname(p);
      $("#wx").hidden = false;
      $("#wx").onclick = () => { map.flyTo([p.lat, p.lon], 9, { duration: 0.8 }); };
    } catch (e) { /* offline */ }
  }
  setInterval(updateWeather, 15 * 60000);

  /* ---- shown inside another page (e.g. the MASRAINMAN Blogger page) ----
   * Browsers block notifications and home-screen install inside an embedded
   * frame, so offer a one-tap "open full app" button there. */
  let EMBEDDED = false;
  try { EMBEDDED = window.self !== window.top; } catch (e) { EMBEDDED = true; }
  if (EMBEDDED && !INLINE) {
    document.body.classList.add("embedded");
    const full = $("#btn-full"); full.href = location.href.split("#")[0]; full.hidden = false;
  }

  /* ---- service worker (offline shell + background checks) ---- */
  if ("serviceWorker" in navigator && location.protocol !== "file:" && !INLINE) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data === "refresh") refresh(true); });
  }

  /* ---- start ---- */
  applyTheme();
  renderAll();
  mirrorToWorker();
  if (!S.onboarded && !EMBEDDED) $("#onboard").classList.add("open");   // inside the blog: show the radar straight away; ⏻ turns the alarm on
  setSheet("peek");
  if (places.length) {
    const b = L.latLngBounds(places.map((p) => [p.lat, p.lon]));
    map.fitBounds(b.pad(0.25), { maxZoom: 9, paddingBottomRight: [0, Math.round(window.innerHeight * 0.4)] });
  }
  refresh(true).then(() => { updateWeather(); if (S.onboarded && navigator.permissions) navigator.permissions.query({ name: "geolocation" }).then((st) => { if (st.state === "granted") locate(false); }).catch(() => {}); });
  // a link like ...?demo or #lat,lon can open a place quickly
  window.__RA = { map, S, refresh, evaluateAll, fireAlarm, frames: () => frames, results };
})();
