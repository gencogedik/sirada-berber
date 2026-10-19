// Sırada service worker: shows phone notifications for the barber panel.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Sırada", { body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag,
      icon: "/assets/app-192.png", badge: "/assets/badge-96.png", data: { url: d.url || "/usta" } });
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: "push" }));
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/usta";
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = cs.find(x => new URL(x.url).pathname.startsWith("/usta"));
    if (c) { await c.focus(); c.postMessage({ type: "push" }); return; }
    await self.clients.openWindow(url);
  })());
});
