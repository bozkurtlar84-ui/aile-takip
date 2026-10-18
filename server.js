/**
 * Aile Cihaz Takip Sunucusu
 * -------------------------------------------------
 * Üç parçanın buluştuğu merkez:
 *   - Telefon uygulaması konum gönderir ve "takip aktif mi?" diye sorar
 *   - Web panel takibi başlatır/durdurur ve konumları gösterir
 *
 * Depolama: Saf JSON dosyası (data/store.json). Hiçbir native/derlenen paket
 * gerektirmez; her işletim sisteminde kurulumsuz çalışır.
 *
 * Güvenlik: Her cihazın bir API anahtarı (deviceKey) vardır. Panel ise
 * ADMIN_KEY ile korunur. Bunlar data/config.json'a yazılır; ilk açılışta
 * otomatik üretilir.
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------------------
// Yapılandırma
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const STORE_PATH = path.join(DATA_DIR, "store.json");

function randomKey() {
  return crypto.randomBytes(16).toString("hex");
}

function loadOrCreateConfig() {
  const fromEnv = {
    adminKey: process.env.ADMIN_KEY,
    deviceKey: process.env.DEVICE_KEY,
  };
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  config.adminKey = fromEnv.adminKey || config.adminKey || randomKey();
  config.deviceKey = fromEnv.deviceKey || config.deviceKey || randomKey();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

const config = loadOrCreateConfig();

// ----------------------------------------------------------------------------
// Basit JSON depolama
// ----------------------------------------------------------------------------
// Yapı:
// {
//   devices: { "telefon-1": { id, name, tracking, lastSeen } },
//   locations: { "telefon-1": [ { lat, lon, accuracy, speed, battery, ts }, ... ] }
// }
const DEFAULT_DEVICE_ID = "telefon-1";
const MAX_HISTORY = 8000; // cihaz başına saklanan en fazla konum sayısı
const MAX_EVENTS = 300;   // olay (uyarı) günlüğü uzunluğu
const ONLINE_MS = 90 * 1000; // bu süre içinde sinyal geldiyse "bağlı"
const LOW_BATTERY = 20;   // % altı düşük pil

let store = { devices: {}, locations: {}, geofences: [], events: [] };

function loadStore() {
  if (fs.existsSync(STORE_PATH)) {
    try {
      store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    } catch (e) {
      console.warn("store.json okunamadı, sıfırdan başlatılıyor:", e.message);
      store = { devices: {}, locations: {} };
    }
  }
  if (!store.devices) store = { devices: {}, locations: {} };
  if (!store.locations) store.locations = {};
  if (!Array.isArray(store.geofences)) store.geofences = [];
  if (!Array.isArray(store.events)) store.events = [];

  // Varsayılan cihaz yoksa oluştur
  if (!store.devices[DEFAULT_DEVICE_ID]) {
    store.devices[DEFAULT_DEVICE_ID] = {
      id: DEFAULT_DEVICE_ID,
      name: "Telefon",
      tracking: false,
      lastSeen: null,
    };
    store.locations[DEFAULT_DEVICE_ID] = store.locations[DEFAULT_DEVICE_ID] || [];
    saveStore();
  }
}

// Diske yazmayı hafifçe geciktir (çok sık yazmayı önlemek için)
let saveTimer = null;
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(store));
    } catch (e) {
      console.error("store.json yazılamadı:", e.message);
    }
  }, 2000);
}

loadStore();

// ----------------------------------------------------------------------------
// Uygulama
// ----------------------------------------------------------------------------
const app = express();
app.set("trust proxy", true); // Render/bulut arkasında gerçek IP için
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// ----------------------------------------------------------------------------
// IP tabanlı yaklaşık konum (GPS kapalıyken yedek)
// ----------------------------------------------------------------------------
// Telefonun bağlandığı IP'den kaba (şehir seviyesi) konum çıkarır.
// Ücretsiz ip-api.com kullanılır (anahtar gerektirmez).
function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  let ip = xf || req.ip || "";
  ip = ip.replace(/^::ffff:/, ""); // IPv4-mapped IPv6 sadeleştir
  return ip;
}

async function updateIpLocation(device, req) {
  try {
    const ip = getClientIp(req);
    if (!ip || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.")) return;
    // Aynı IP için 10 dakikada bir yenile (gereksiz sorgu olmasın)
    const prev = device.ipLocation;
    if (prev && prev.ip === ip && Date.now() - prev.ts < 10 * 60 * 1000) return;

    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon`);
    const j = await r.json();
    if (j.status !== "success" || typeof j.lat !== "number") return;
    device.ipLocation = {
      ip,
      lat: j.lat,
      lon: j.lon,
      city: j.city || null,
      region: j.regionName || null,
      country: j.country || null,
      ts: Date.now(),
    };
    saveStore();
  } catch (e) {
    // sessizce geç; IP konumu yalnızca bir yedektir
  }
}

// --- Kimlik doğrulama ---
function requireDeviceKey(req, res, next) {
  const key = req.get("x-device-key") || req.query.key;
  if (key !== config.deviceKey) {
    return res.status(401).json({ error: "Geçersiz cihaz anahtarı" });
  }
  next();
}
function requireAdminKey(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key;
  if (key !== config.adminKey) {
    return res.status(401).json({ error: "Geçersiz yönetici anahtarı" });
  }
  next();
}

function getDevice(id) {
  return store.devices[id] || null;
}
function lastLocation(id) {
  const arr = store.locations[id];
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// ============================================================================
// TELEFON TARAFI
// ============================================================================

// Cihaz bilgisi (üretici/model/sürüm) ve son IP'yi kaydet
function touchDevice(device, req, info) {
  device.lastSeen = Date.now();
  device.lastIp = getClientIp(req);
  if (info && typeof info === "object") {
    const clean = (v) => (typeof v === "string" ? v.slice(0, 80) : undefined);
    const next = {
      brand: clean(info.brand),
      model: clean(info.model),
      os: clean(info.os),
      app: clean(info.app),
    };
    if (next.brand || next.model) device.info = { ...(device.info || {}), ...next };
  }
}

function infoFromQuery(q) {
  return { brand: q.brand, model: q.model, os: q.os, app: q.app };
}

function addEvent(deviceId, type, text, extra) {
  store.events.push({ id: crypto.randomBytes(4).toString("hex"), ts: Date.now(), deviceId, type, text, ...(extra || {}) });
  if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS);
}

function deviceLabel(d) {
  return d.name || d.id;
}

// Bölge (geofence) giriş/çıkış kontrolü
function checkGeofences(device, lat, lon) {
  if (!device.geoState) device.geoState = {};
  for (const g of store.geofences) {
    if (g.deviceId && g.deviceId !== device.id) continue;
    const inside = haversine({ lat, lon }, g) <= g.radius;
    const prev = device.geoState[g.id];
    if (prev === undefined) { device.geoState[g.id] = inside; continue; } // ilk ölçüm: olay üretme
    if (inside !== prev) {
      device.geoState[g.id] = inside;
      addEvent(device.id, inside ? "geo-enter" : "geo-exit",
        `${deviceLabel(device)} "${g.name}" bölgesine ${inside ? "girdi" : "çıktı"}`,
        { gfId: g.id, lat, lon });
    }
  }
}

// Telefon periyodik olarak burayı yoklar. tracking=true ise konum göndermeye başlar.
// Bilinmeyen cihaz (geçerli cihaz anahtarıyla) otomatik kaydedilir -> çoklu cihaz.
app.get("/api/device/:id/status", requireDeviceKey, (req, res) => {
  const id = req.params.id;
  let device = getDevice(id);
  if (!device) {
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(id)) return res.status(404).json({ error: "Cihaz bulunamadı" });
    const q = req.query;
    device = store.devices[id] = {
      id,
      name: [q.brand, q.model].filter(Boolean).join(" ").slice(0, 60) || "Yeni cihaz",
      tracking: false,
      lastSeen: null,
      tags: [],
    };
    store.locations[id] = [];
    addEvent(id, "new-device", `Yeni cihaz eklendi: ${device.name}`);
  }

  touchDevice(device, req, infoFromQuery(req.query));
  saveStore();
  updateIpLocation(device, req); // arka planda IP konumu tazele

  res.json({ tracking: !!device.tracking, name: device.name });
});

// Telefon takip aktifken konumunu buraya gönderir.
app.post("/api/device/:id/location", requireDeviceKey, (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Cihaz bulunamadı" });

  const { lat, lon, accuracy, speed, battery } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ error: "lat ve lon zorunlu" });
  }

  const now = Date.now();
  if (!store.locations[req.params.id]) store.locations[req.params.id] = [];
  const arr = store.locations[req.params.id];
  arr.push({
    lat, lon,
    accuracy: accuracy ?? null,
    speed: speed ?? null,
    battery: battery ?? null,
    ts: now,
  });
  // Geçmişi sınırla
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);

  touchDevice(device, req, req.body.info);
  checkGeofences(device, lat, lon);

  // Düşük pil olayı (bir kez; şarj olunca sıfırlanır)
  if (typeof battery === "number") {
    if (battery <= LOW_BATTERY && !device.lowBatNotified) {
      device.lowBatNotified = true;
      addEvent(device.id, "low-battery", `${deviceLabel(device)} pili %${battery}'e düştü`);
    } else if (battery > LOW_BATTERY + 5) {
      device.lowBatNotified = false;
    }
  }
  saveStore();
  updateIpLocation(device, req);

  res.json({ ok: true, tracking: !!device.tracking });
});

// ============================================================================
// PANEL TARAFI (yönetici)
// ============================================================================

// Bağlantı / aktiflik durumunu hesapla
function connectionState(d) {
  const now = Date.now();
  const loc = lastLocation(d.id);
  const sinceSeen = d.lastSeen ? now - d.lastSeen : null;
  const online = sinceSeen !== null && sinceSeen <= ONLINE_MS;
  const locFresh = !!loc && now - loc.ts <= ONLINE_MS * 2;
  let activity; // "active" | "waiting" | "idle"
  if (d.tracking && online && locFresh) activity = "active";      // takip açık, konum akıyor
  else if (d.tracking) activity = "waiting";                       // takip istendi ama konum gelmiyor
  else activity = "idle";                                          // takip kapalı
  return { online, sinceSeenMs: sinceSeen, activity };
}

function publicDevice(d) {
  return {
    id: d.id,
    name: d.name,
    tags: d.tags || [],
    tracking: !!d.tracking,
    lastSeen: d.lastSeen,
    ip: d.lastIp || null,
    info: d.info || null,
    lastLocation: lastLocation(d.id),
    ipLocation: d.ipLocation || null,
    ...connectionState(d),
  };
}

// Cihaz listesi + son konumları
app.get("/api/admin/devices", requireAdminKey, (req, res) => {
  res.json({ devices: Object.values(store.devices).map(publicDevice), serverTime: Date.now() });
});

// Takibi başlat / durdur
app.post("/api/admin/devices/:id/tracking", requireAdminKey, (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Cihaz bulunamadı" });

  device.tracking = !!req.body.enabled;
  saveStore();
  res.json({ ok: true, tracking: device.tracking });
});

// Konum geçmişi (en yeni önce)
app.get("/api/admin/devices/:id/history", requireAdminKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, MAX_HISTORY);
  const arr = store.locations[req.params.id] || [];
  const history = arr.slice(-limit).reverse();
  res.json({ history });
});

// --- Gün bazlı konumlar + durak tespiti -------------------------------------
// ?date=YYYY-MM-DD (yerel gün sınırları offset dakikasıyla ayarlanır)
// tzOffsetMin: tarayıcının getTimezoneOffset() değeri (örn. Türkiye için -180)
app.get("/api/admin/devices/:id/day", requireAdminKey, (req, res) => {
  const arr = store.locations[req.params.id] || [];
  const dateStr = req.query.date; // YYYY-MM-DD
  const tzOffsetMin = parseInt(req.query.tzOffsetMin);
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;

  let points = arr;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // Yerel günün [00:00, 24:00) sınırlarını UTC ms cinsine çevir.
    // Yerel zaman = UTC - off(dk).  => UTC = yerel + off(dk)
    const [y, m, d] = dateStr.split("-").map(Number);
    const localMidnightUTC = Date.UTC(y, m - 1, d) + off * 60000;
    const start = localMidnightUTC;
    const end = start + 24 * 3600 * 1000;
    points = arr.filter((p) => p.ts >= start && p.ts < end);
  }

  const stops = computeStops(points);
  res.json({ points, stops, count: points.length });
});

// Hangi günlerde veri var? (tarih seçiciyi doldurmak için)
app.get("/api/admin/devices/:id/days", requireAdminKey, (req, res) => {
  const arr = store.locations[req.params.id] || [];
  const tzOffsetMin = parseInt(req.query.tzOffsetMin);
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  const set = new Set();
  for (const p of arr) {
    // UTC ms -> yerel tarih
    const localMs = p.ts - off * 60000;
    const dt = new Date(localMs);
    const ds = dt.getUTCFullYear() + "-" +
      String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(dt.getUTCDate()).padStart(2, "0");
    set.add(ds);
  }
  res.json({ days: Array.from(set).sort().reverse() });
});

/**
 * Durak tespiti: Ardışık konumlar belirli bir yarıçap (STOP_RADIUS_M) içinde
 * ve toplam süre eşikten (STOP_MIN_MINUTES) uzunsa, bunu bir "durak" sayar.
 */
const STOP_RADIUS_M = 120;      // bu yarıçap içinde kalırsa aynı yer sayılır
const STOP_MIN_MINUTES = 10;    // en az bu kadar dakika kalırsa durak

function haversine(a, b) {
  const R = 6371000; // m
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeStops(points) {
  if (!points || points.length === 0) return [];
  // Zaman sırasına koy
  const pts = [...points].sort((a, b) => a.ts - b.ts);
  const stops = [];
  let i = 0;
  while (i < pts.length) {
    let j = i + 1;
    // i'den itibaren yarıçap içinde kalan ardışık noktaları topla
    let sumLat = pts[i].lat, sumLon = pts[i].lon, n = 1;
    while (j < pts.length) {
      const center = { lat: sumLat / n, lon: sumLon / n };
      if (haversine(center, pts[j]) <= STOP_RADIUS_M) {
        sumLat += pts[j].lat; sumLon += pts[j].lon; n++;
        j++;
      } else break;
    }
    const durationMin = (pts[j - 1].ts - pts[i].ts) / 60000;
    if (durationMin >= STOP_MIN_MINUTES && n >= 2) {
      stops.push({
        lat: sumLat / n,
        lon: sumLon / n,
        start: pts[i].ts,
        end: pts[j - 1].ts,
        durationMin: Math.round(durationMin),
        samples: n,
      });
    }
    i = j > i ? j : i + 1;
  }
  return stops;
}

// Etiketler (örn. "Anne", "Okul telefonu")
app.post("/api/admin/devices/:id/tags", requireAdminKey, (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Cihaz bulunamadı" });
  const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
  device.tags = tags
    .map((t) => String(t).trim().slice(0, 24))
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 8);
  saveStore();
  res.json({ ok: true, tags: device.tags });
});

// Bölgeler (geofence)
app.get("/api/admin/geofences", requireAdminKey, (req, res) => {
  res.json({ geofences: store.geofences });
});
app.post("/api/admin/geofences", requireAdminKey, (req, res) => {
  const { name, lat, lon, radius, deviceId } = req.body;
  if (!name || typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ error: "name, lat, lon zorunlu" });
  }
  const g = {
    id: crypto.randomBytes(4).toString("hex"),
    name: String(name).trim().slice(0, 40),
    lat, lon,
    radius: Math.min(Math.max(parseInt(radius) || 150, 50), 5000),
    deviceId: deviceId || null,
  };
  store.geofences.push(g);
  if (store.geofences.length > 50) store.geofences.shift();
  saveStore();
  res.json({ ok: true, geofence: g });
});
app.delete("/api/admin/geofences/:gid", requireAdminKey, (req, res) => {
  store.geofences = store.geofences.filter((g) => g.id !== req.params.gid);
  for (const d of Object.values(store.devices)) if (d.geoState) delete d.geoState[req.params.gid];
  saveStore();
  res.json({ ok: true });
});

// Olay (uyarı) günlüğü: yeni -> eski
app.get("/api/admin/events", requireAdminKey, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const events = store.events.filter((e) => e.ts > since).slice(-100).reverse();
  res.json({ events });
});

// Haftalık / aylık özet
app.get("/api/admin/devices/:id/summary", requireAdminKey, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 60);
  const tzOffsetMin = parseInt(req.query.tzOffsetMin);
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  const arr = (store.locations[req.params.id] || []).slice().sort((a, b) => a.ts - b.ts);
  const dayKey = (ts) => {
    const dt = new Date(ts - off * 60000);
    return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
  };
  const todayStart = (() => {
    const k = dayKey(Date.now()).split("-").map(Number);
    return Date.UTC(k[0], k[1] - 1, k[2]) + off * 60000;
  })();
  const from = todayStart - (days - 1) * 86400000;

  const perDay = {};
  for (let i = 0; i < days; i++) {
    perDay[dayKey(from + i * 86400000 + 3600000)] = { date: dayKey(from + i * 86400000 + 3600000), distanceKm: 0, points: 0, stops: 0, stopMin: 0 };
  }
  const byDay = {};
  for (const p of arr) {
    if (p.ts < from) continue;
    const k = dayKey(p.ts);
    if (!perDay[k]) continue;
    (byDay[k] = byDay[k] || []).push(p);
  }
  const allStops = [];
  for (const [k, pts] of Object.entries(byDay)) {
    let dist = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = haversine(pts[i - 1], pts[i]);
      const dt = (pts[i].ts - pts[i - 1].ts) / 1000;
      if (d < 15) continue;                       // GPS titremesini say
      if (dt > 0 && d / dt > 70) continue;        // 250 km/s üstü sıçrama = hatalı nokta
      dist += d;
    }
    const stops = computeStops(pts);
    perDay[k].distanceKm = Math.round(dist / 100) / 10;
    perDay[k].points = pts.length;
    perDay[k].stops = stops.length;
    perDay[k].stopMin = stops.reduce((a, s) => a + s.durationMin, 0);
    allStops.push(...stops);
  }
  // Benzer durakları birleştir -> en çok vakit geçirilen yerler
  const places = [];
  for (const s of allStops) {
    const hit = places.find((p) => haversine(p, s) <= 200);
    if (hit) {
      hit.visits++; hit.minutes += s.durationMin;
      hit.lat = (hit.lat * (hit.visits - 1) + s.lat) / hit.visits;
      hit.lon = (hit.lon * (hit.visits - 1) + s.lon) / hit.visits;
    } else places.push({ lat: s.lat, lon: s.lon, visits: 1, minutes: s.durationMin });
  }
  places.sort((a, b) => b.minutes - a.minutes);
  const list = Object.values(perDay);
  res.json({
    days: list,
    totalKm: Math.round(list.reduce((a, d) => a + d.distanceKm, 0) * 10) / 10,
    activeDays: list.filter((d) => d.points > 0).length,
    topPlaces: places.slice(0, 5),
  });
});

// Cihaz adını değiştir
app.post("/api/admin/devices/:id/name", requireAdminKey, (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Cihaz bulunamadı" });
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Geçerli bir isim gerekli" });
  }
  device.name = name.trim();
  saveStore();
  res.json({ ok: true });
});

// Bağlantı kopma / geri gelme olayları (30 sn'de bir kontrol)
setInterval(() => {
  let changed = false;
  for (const d of Object.values(store.devices)) {
    if (!d.lastSeen) continue;
    const online = Date.now() - d.lastSeen <= ONLINE_MS;
    if (d.wasOnline === undefined) { d.wasOnline = online; continue; }
    if (online !== d.wasOnline) {
      d.wasOnline = online;
      addEvent(d.id, online ? "online" : "offline",
        online ? `${deviceLabel(d)} tekrar bağlandı` : `${deviceLabel(d)} bağlantısı koptu`);
      changed = true;
    }
  }
  if (changed) saveStore();
}, 30000);

// ============================================================================
// WEB PANEL (statik dosyalar)
// ============================================================================
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("\n==============================================");
  console.log("  Aile Takip Sunucusu calisiyor");
  console.log("==============================================");
  console.log(`  Panel adresi : http://localhost:${PORT}`);
  console.log(`  Yonetici anahtari (panel girisi): ${config.adminKey}`);
  console.log(`  Cihaz anahtari  (telefon ayari) : ${config.deviceKey}`);
  console.log("==============================================\n");
});
