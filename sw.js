// sw.js — service worker for The Freedom Intelligence Field PWA.
// Lives at the site root (/sw.js) so it controls the whole domain.
// Responsibilities:
//   1. Receive Web Push events and display the notification
//   2. Handle notification clicks (open or focus the app)
//
// Intentionally minimal — no caching, no offline-first behavior. We use this
// service worker solely for push notifications.

self.addEventListener("install", (event) => {
  // Activate immediately on install so the latest worker version takes over.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of all open clients right away.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "The Field", body: "" };
  try {
    if (event.data) {
      const text = event.data.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          payload = { ...payload, ...parsed };
        }
      }
    }
  } catch (e) {
    // Bad JSON — fall through with defaults.
  }

  const title = payload.title || "The Field";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icons/icon-192.png",
    badge: payload.badge || "/icons/badge-96.png",
    data: { url: payload.url || "/" },
    tag: payload.tag || undefined,
    requireInteraction: !!payload.requireInteraction,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        // If a window for our origin is already open, focus it instead of
        // opening a new tab.
        for (const client of clientsArr) {
          if ("focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});
