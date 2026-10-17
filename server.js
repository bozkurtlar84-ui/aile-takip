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
const MAX_HISTORY = 1000; // cihaz başına saklanan en fazla konum sayısı

let store = { devices: {}, locations: {} };

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
  }, 300);
}

loadStore();

// ----------------------------------------------------------------------------
// Uygulama
// ----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

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

// Telefon periyodik olarak burayı yoklar. tracking=true ise konum göndermeye başlar.
app.get("/api/device/:id/status", requireDeviceKey, (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Cihaz bulunamadı" });

  device.lastSeen = Date.now();
  saveStore();

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

  device.lastSeen = now;
  saveStore();

  res.json({ ok: true, tracking: !!device.tracking });
});

// ============================================================================
// PANEL TARAFI (yönetici)
// ============================================================================

// Cihaz listesi + son konumları
app.get("/api/admin/devices", requireAdminKey, (req, res) => {
  const devices = Object.values(store.devices).map((d) => ({
    id: d.id,
    name: d.name,
    tracking: !!d.tracking,
    lastSeen: d.lastSeen,
    lastLocation: lastLocation(d.id),
  }));
  res.json({ devices });
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
