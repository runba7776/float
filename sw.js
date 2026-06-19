const CACHE = 'floatcam-v2';
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

// ネットワーク優先: まずサーバーから最新版を取りに行き、取れた場合はキャッシュも更新する。
// オフラインなど取得できない場合だけ、保存済みキャッシュを使う。
// これにより「更新したのに古い画面のまま表示され続ける」問題を防ぐ。
self.addEventListener('fetch', e=>{
  if(new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res=>{
        const resClone = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, resClone));
        return res;
      })
      .catch(()=> caches.match(e.request))
  );
});
