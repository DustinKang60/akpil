/* 악필 서비스워커
   ─────────────────────────────────────────────────────────
   에셋을 고치면 아래 CACHE 버전을 반드시 올릴 것.
   올리지 않으면 기기는 저장된 옛 코드를 계속 쓴다.
   ───────────────────────────────────────────────────────── */
const CACHE = 'akpil-v22';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/favicon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패하면 캐시. 새 코드가 바로 반영되도록.
//
// cache:'reload' 가 핵심이다. 그냥 fetch(req) 를 쓰면 브라우저의 HTTP 캐시가
// 낡은 파일을 내주고, 서비스워커는 그걸 "네트워크에서 받은 최신"으로 믿는다.
// 이때는 아래 CACHE 버전을 아무리 올려도 소용이 없다. 캐시가 서비스워커가
// 아니라 그 아래층에 있기 때문이다.
// 실제로 styles.css 가 이렇게 낡은 채로 남아, 새로 넣은 음량 막대가 폭 0 이
// 되어 화면에서 사라진 적이 있다. 같은 파일을 폰에서 받아 비교해 확인했다.
//   그냥 fetch → 11,716 바이트 (옛것) / cache:'reload' → 12,280 바이트 (새것)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'reload' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
