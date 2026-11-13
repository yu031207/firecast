// 오프라인용 저장: 화면·엔진·자료를 한 번 받으면 인터넷 없이도 열림 (지도 배경은 인터넷 필요)
const CACHE = 'firecast-v2';
const FILES = ['./', './index.html', './app.js', './engine.js', './config.js', './manifest.json',
  './data/model.json', './tiles/index.json',
  './lib/proj4.js', './lib/leaflet/leaflet.js', './lib/leaflet/leaflet.css', './icons/icon-192.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                 // 지도 타일·기상청은 그대로 인터넷에서
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
