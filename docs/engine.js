/* MasRainman Rain Alarm -- shared engine.
 * Loaded by the page (index.html) and by the service worker (sw.js), so the
 * same rules decide an alarm whether the app is open or checking in the
 * background. No DOM use in here except the optional RainViewer sampler.
 */
(function (root) {
  "use strict";

  const RA = {};
  RA.DATA_BASE = "data/";
  RA.NO_COVER = 255;

  /* ---------- colour scale: rain rate in mm/h (rain-alarm style) ----------
   * dBZ -> mm/h with Marshall-Palmer Z = 200 R^1.6, so  dBZ = 23 + 16 log10(R).
   * IMD images start at ~20 dBZ (0.6 mm/h); the lighter steps come from
   * RainViewer / the model. */
  RA.mmh = (dbz) => (dbz <= 0 ? 0 : Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6));
  RA.dbzOf = (mmh) => 23.01 + 16 * Math.log10(mmh);
  RA.BANDS = [
    { mm: 0.2, color: "#9cc8ff", en: "Drizzle", ta: "தூறல்" },
    { mm: 0.3, color: "#5ea2ff", en: "Drizzle", ta: "தூறல்" },
    { mm: 0.6, color: "#2a6bff", en: "Light", ta: "லேசான மழை" },
    { mm: 1.3, color: "#0b26e6", en: "Light", ta: "லேசான மழை" },
    { mm: 3, color: "#fff200", en: "Moderate", ta: "மிதமான மழை" },
    { mm: 6, color: "#ffa200", en: "Mod-Heavy", ta: "சற்று கனமழை" },
    { mm: 12, color: "#ff2b1c", en: "Heavy", ta: "கனமழை" },
    { mm: 24, color: "#c3000f", en: "Very Heavy", ta: "மிக கனமழை" },
    { mm: 50, color: "#ff2dff", en: "Intense", ta: "தீவிர மழை" },
    { mm: 100, color: "#c400d6", en: "Torrential", ta: "அதி தீவிர மழை" },
    { mm: 205, color: "#8a00b0", en: "Extreme", ta: "அதி தீவிர மழை" },
    { mm: 420, color: "#55007a", en: "Extreme / hail", ta: "ஆலங்கட்டி அபாயம்" },
  ].map((b) => Object.assign(b, { min: RA.dbzOf(b.mm) }));
  RA.band = function (dbz) {
    let b = null;
    for (const x of RA.BANDS) if (dbz >= x.min) b = x;
    return b;
  };
  // Alert tiers (what the caption bot already uses)
  RA.TIERS = [
    { min: 50, en: "Very heavy rain / thunderstorm", ta: "இடியுடன் கூடிய மிக கனமழை" },
    { min: 45, en: "Very heavy rain", ta: "மிக கனமழை" },
    { min: 40, en: "Heavy rain", ta: "கனமழை" },
    { min: 30, en: "Moderate rain", ta: "மிதமான மழை" },
    { min: 20, en: "Light rain", ta: "லேசான மழை" },
  ];
  RA.tier = function (dbz) {
    for (const t of RA.TIERS) if (dbz >= t.min) return t;
    return null;
  };
  RA.DIRS_EN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  RA.DIRS_TA = ["வடக்கு", "வடகிழக்கு", "கிழக்கு", "தென்கிழக்கு", "தெற்கு", "தென்மேற்கு", "மேற்கு", "வடமேற்கு"];
  RA.dirIndex = (deg) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

  /* ---------- small helpers ---------- */
  const R_EARTH = 6371;
  RA.distKm = function (la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(a));
  };
  RA.bearing = function (la1, lo1, la2, lo2) {
    const r = Math.PI / 180;
    const y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
    const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
    return ((Math.atan2(y, x) / r) + 360) % 360;
  };
  RA.clockIST = function (date) {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })
      .format(date).replace(/\s?(am|pm)/i, (m) => " " + m.trim().toUpperCase());
  };

  async function gunzip(buf) {
    const u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;          // server already un-gzipped it
    if (typeof DecompressionStream !== "undefined") {
      const ds = new DecompressionStream("gzip");
      const out = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(out);
    }
    if (root.pako) return root.pako.ungzip(u8);
    throw new Error("This browser cannot unpack the radar file");
  }
  const bust = () => "?t=" + Math.floor(Date.now() / 60000);

  /* ---------- IMD nowcast (from the MasRainman radar engine) ---------- */
  RA.loadImd = async function (base) {
    base = base || RA.DATA_BASE;
    if (root.RA_INLINE_DATA) return RA.fromInline(root.RA_INLINE_DATA);
    const doc = await (await fetch(base + "nowcast.json" + bust(), { cache: "no-store" })).json();
    const g = doc.grid;
    const out = { doc, g, layers: [], history: [] };
    if (!g) return out;
    const raw = await gunzip(await (await fetch(base + "nowcast_grid.bin.gz?v=" + doc.version)).arrayBuffer());
    const n = g.nrows * g.ncols;
    g.layers.forEach((L, i) => {
      out.layers.push({
        name: L.name, lead: L.lead_min || 0,
        time: new Date(new Date(doc.generated_utc).getTime() + (L.lead_min || 0) * 60000),
        bytes: raw.subarray(i * n, (i + 1) * n),
      });
    });
    return out;
  };
  RA.loadImdHistory = async function (imd, base) {
    base = base || RA.DATA_BASE;
    if (!imd.g || root.RA_INLINE_DATA) return imd;
    try {
      const h = await (await fetch(base + "history.json" + bust(), { cache: "no-store" })).json();
      const g = imd.g, geom = [g.lat_north, g.lon_west, g.step_deg, g.nrows, g.ncols].join();
      const frames = (h.frames || []).filter((f) => f.version !== imd.doc.version && (f.geom || []).join() === geom);
      const got = await Promise.all(frames.map(async (f) => {
        try {
          const b = await gunzip(await (await fetch(base + "history/" + f.version + ".bin.gz")).arrayBuffer());
          return { name: "past", lead: 0, time: new Date(f.time_utc), bytes: b };
        } catch (e) { return null; }
      }));
      imd.history = got.filter(Boolean).sort((a, b) => a.time - b.time);
    } catch (e) { /* no history yet */ }
    return imd;
  };
  RA.fromInline = function (d) {
    // d = {doc, layersB64:[...], history:[{time_utc,b64}]}  (used by the preview build)
    const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    if (d.rebase) {                        // preview build: pretend the sample was made just now
      const shift = Date.now() - new Date(d.doc.generated_utc).getTime();
      d.doc.generated_utc = new Date(Date.now()).toISOString();
      (d.history || []).forEach((h) => { h.time_utc = new Date(new Date(h.time_utc).getTime() + shift).toISOString(); });
      d.rebase = false;
    }
    const g = d.doc.grid, out = { doc: d.doc, g, layers: [], history: [] };
    g.layers.forEach((L, i) => out.layers.push({
      name: L.name, lead: L.lead_min || 0,
      time: new Date(new Date(d.doc.generated_utc).getTime() + (L.lead_min || 0) * 60000),
      bytes: RA.unrle(dec(d.layersB64[i]), g.nrows * g.ncols),
    }));
    out.history = (d.history || []).map((h) => ({ name: "past", lead: 0, time: new Date(h.time_utc), bytes: RA.unrle(dec(h.b64), g.nrows * g.ncols) }));
    return out;
  };
  RA.unrle = function (u8, n) {           // pairs of (value, runLength<=255)
    const out = new Uint8Array(n);
    let k = 0;
    for (let i = 0; i + 1 < u8.length; i += 2) { out.fill(u8[i], k, k + u8[i + 1]); k += u8[i + 1]; }
    return out;
  };
  RA.imdAgeMin = (imd) => (Date.now() - new Date(imd.doc.generated_utc).getTime()) / 60000;
  RA.imdFresh = (imd) => imd && imd.g && RA.imdAgeMin(imd) <= ((imd.doc.stale_after_min || 30) + 5);

  /* Max dBZ around a point -- same rule as alerts.py: ignore a single
   * isolated pixel (second-highest echo), null if no radar sees the point. */
  RA.sample = function (g, bytes, lat, lon, radiusKm) {
    const step = g.step_deg, kmLat = step * 111, kmLon = step * 111 * Math.cos(lat * Math.PI / 180);
    const r = Math.round((g.lat_north - lat) / step), c = Math.round((lon - g.lon_west) / step);
    const dr = Math.max(1, Math.ceil(radiusKm / kmLat)), dc = Math.max(1, Math.ceil(radiusKm / kmLon));
    let covered = 0, top = 0, second = 0;
    for (let i = Math.max(0, r - dr); i <= Math.min(g.nrows - 1, r + dr); i++) {
      for (let j = Math.max(0, c - dc); j <= Math.min(g.ncols - 1, c + dc); j++) {
        if (Math.hypot((i - r) * kmLat, (j - c) * kmLon) > radiusKm) continue;
        const v = bytes[i * g.ncols + j];
        if (v === RA.NO_COVER) continue;
        covered++;
        if (v > top) { second = top; top = v; } else if (v > second) second = v;
      }
    }
    if (!covered) return null;
    return second;
  };
  /* Nearest echo >= thr within maxKm: {km, brg (from place), dbz} */
  RA.nearest = function (g, bytes, lat, lon, maxKm, thr) {
    const step = g.step_deg, kmLat = step * 111, kmLon = step * 111 * Math.cos(lat * Math.PI / 180);
    const r = Math.round((g.lat_north - lat) / step), c = Math.round((lon - g.lon_west) / step);
    const dr = Math.ceil(maxKm / kmLat), dc = Math.ceil(maxKm / kmLon);
    let best = null;
    for (let i = Math.max(0, r - dr); i <= Math.min(g.nrows - 1, r + dr); i++) {
      for (let j = Math.max(0, c - dc); j <= Math.min(g.ncols - 1, c + dc); j++) {
        const v = bytes[i * g.ncols + j];
        if (v === RA.NO_COVER || v < thr) continue;
        const d = Math.hypot((i - r) * kmLat, (j - c) * kmLon);
        if (d <= maxKm && (!best || d < best.km - 0.5 || (Math.abs(d - best.km) <= 0.5 && v > best.dbz))) {
          best = { km: d, brg: (Math.atan2((j - c) * kmLon, (r - i) * kmLat) * 180 / Math.PI + 360) % 360, dbz: v };
        }
      }
    }
    return best;
  };

  /* ---------- the alarm decision for one place ---------- */
  // settings: {thr, windowMin}
  RA.evaluateImd = function (imd, place, s) {
    if (!RA.imdFresh(imd) || !imd.layers.length) return null;
    const g = imd.g, obs = imd.layers[0].bytes;
    const nowDbz = RA.sample(g, obs, place.lat, place.lon, 3);
    if (nowDbz === null) return null;                              // outside IMD radar -> fallback
    const res = { src: "imd", now: nowDbz, strip: [], eta: null, end: null, peak: 0, near: null };
    for (const L of imd.layers) {
      const rad = Math.max(3, L.lead / 6);                         // uncertainty widens with lead time
      const v = RA.sample(g, L.bytes, place.lat, place.lon, rad);
      res.strip.push({ lead: L.lead, time: L.time, dbz: v === null ? -1 : v });
      if (L.lead > 0 && L.lead <= s.windowMin && v !== null) {
        if (v >= s.thr && res.eta === null && nowDbz < s.thr) res.eta = L.lead;
        if (v >= s.thr) res.peak = Math.max(res.peak, v);
        if (nowDbz >= s.thr && v < s.thr && res.end === null) res.end = L.lead;
      }
    }
    const near = RA.nearest(g, obs, place.lat, place.lon, 40, s.thr);
    if (near) {
      const mv = imd.doc.motion || {};
      let approaching = null;
      if (mv.available && mv.overall_bearing_deg != null) {
        // storm moves toward bearing B; it approaches if it lies "behind" us along B
        const from = (near.brg + 180) % 360;
        const diff = Math.abs(((mv.overall_bearing_deg - from + 540) % 360) - 180);
        approaching = diff < 60;
      }
      res.near = Object.assign(near, { approaching, speed: mv.overall_speed_kmh || null });
    }
    res.level = RA.levelOf(res, s);
    return res;
  };
  RA.levelOf = function (res, s) {
    if (res.now >= s.thr) return 3;                 // raining now
    if (res.eta !== null) return 2;                 // coming within window
    if (res.near && res.near.km <= 25) return 1;    // rain cloud close by
    return 0;
  };

  /* ---------- text, Tamil + English ---------- */
  RA.describe = function (res, place, s, lang) {
    const out = { en: "", ta: "" };
    if (!res) { out.en = "Checking…"; out.ta = "சரிபார்க்கிறது…"; return out; }
    if (res.level === 3) {
      const t = RA.tier(res.now);
      out.en = `Raining now · ${t.en}` + (res.end ? ` · easing in ~${res.end} min` : "");
      out.ta = `இப்போது ${t.ta} பெய்கிறது` + (res.end ? ` · ~${res.end} நிமிடத்தில் குறையும்` : "");
    } else if (res.level === 2) {
      const t = RA.tier(Math.max(res.peak, s.thr));
      const clock = RA.clockIST(new Date(Date.now() + res.eta * 60000));
      const approx = res.src === "imd" ? "" : "~";
      out.en = `${t.en} in ${approx}${res.eta} min (${clock})`;
      out.ta = `${approx}${res.eta} நிமிடத்தில் ${t.ta} (${clock})`;
    } else if (res.near) {
      const k = Math.round(res.near.km), i = RA.dirIndex(res.near.brg);
      const t = RA.tier(res.near.dbz) || RA.TIERS[RA.TIERS.length - 1];
      const mv = res.near.approaching === true ? [" · moving towards you", " · உங்களை நோக்கி வருகிறது"]
        : res.near.approaching === false ? [" · moving away", " · விலகிச் செல்கிறது"] : ["", ""];
      out.en = `${t.en} ${k} km ${RA.DIRS_EN[i]}${mv[0]}`;
      out.ta = `${k} கி.மீ ${RA.DIRS_TA[i]} திசையில் ${t.ta}${mv[1]}`;
    } else {
      out.en = `No rain expected in the next ${s.windowMin} min`;
      out.ta = `அடுத்த ${s.windowMin} நிமிடம் மழை வாய்ப்பு இல்லை`;
    }
    if (res.src === "rv") { out.en += " · RainViewer"; out.ta += " · RainViewer"; }
    if (res.src === "model") { out.en += " · model estimate"; out.ta += " · மாதிரி கணிப்பு"; }
    return out;
  };
  RA.alarmTitle = function (res, place, lang) {
    const name = lang === "en" ? place.en : (place.ta || place.en);
    if (res.level === 3) return lang === "en" ? `🌧️ Rain at ${name} now` : `🌧️ ${name}: இப்போது மழை`;
    return lang === "en" ? `⏰ Rain coming to ${name}` : `⏰ ${name}: மழை வருகிறது`;
  };

  /* ---------- model fallback: Open-Meteo 15-minute precipitation ---------- */
  RA.evaluateModel = async function (place, s) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}` +
      `&minutely_15=precipitation&forecast_minutely_15=8&past_minutely_15=0&timezone=GMT`;
    const j = await (await fetch(url)).json();
    const m = j.minutely_15 || {};
    const res = { src: "model", now: 0, strip: [], eta: null, end: null, peak: 0, near: null };
    // mm per 15 min -> rough dBZ (Marshall-Palmer) so the same thresholds apply
    const toDbz = (mm) => { const rr = mm * 4; return rr <= 0.05 ? 0 : 10 * Math.log10(200 * rr ** 1.6); };
    (m.time || []).forEach((t, i) => {
      const time = new Date(t + "Z"), lead = Math.max(0, Math.round((time - Date.now()) / 60000));
      const d = toDbz(m.precipitation[i] || 0);
      res.strip.push({ lead, time, dbz: d });
      if (i === 0) res.now = d;
      else if (lead <= s.windowMin && d >= s.thr) { if (res.eta === null && res.now < s.thr) res.eta = Math.max(lead, 5); res.peak = Math.max(res.peak, d); }
    });
    res.level = RA.levelOf(res, s);
    return res;
  };

  root.RA = RA;
})(typeof self !== "undefined" ? self : window);
