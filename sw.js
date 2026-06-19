const CACHE = 'floatcam-v1';
const ASSETS = ['./index.html','./style.css','./app.js','./manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  // 同一オリジンのアプリ本体だけキャッシュ。外部サイト(ブラウザ機能で開くページ)はキャッシュしない。
  if(new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached=> cached || fetch(e.request))
  );
});
