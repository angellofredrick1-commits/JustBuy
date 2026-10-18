/* JustBuy notifications: every status update on your packages, with an unread count.
   Read state is kept on the server, so it matches across devices.

   JBNotify({
     load:     async () => ({ seen_at, items:[{tracking_no, description, status, location, note, happened_at, posted_at}] }) | null,
     markRead: async () => seen_at,
     list:     element to render into,
     badges:   [elements that show the unread count],
     onOpen:   tracking_no => void   // user tapped a notification
   }) → { refresh(), opened(), closed(), unread() }
*/
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DONE = ["Delivered"], HOLD = ["On hold"];
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return "Just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Dar_es_Salaam" });
  }
  function icon(status) {
    const kind = DONE.includes(status) ? "done" : HOLD.includes(status) ? "hold" : "move";
    const path = kind === "done" ? '<path d="M5 12.5 10 17 19 7.5"/>'
      : kind === "hold" ? '<path d="M12 7v6M12 16.5v.5"/>'
      : '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z"/><path d="M4 8.5 12 13l8-4.5M12 13v7"/>';
    return `<span class="n-ic ${kind}" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
  }

  window.JBNotify = function (o) {
    let data = null, seenWhenOpened = null, isOpen = false, timer = null, needsMark = false;
    const unreadOf = (seen) => !data ? 0 : data.items.filter(i => !seen || new Date(i.posted_at) > new Date(seen)).length;

    function paintBadges() {
      const n = isOpen ? 0 : unreadOf(data && data.seen_at);
      o.badges.forEach(b => {
        b.textContent = n > 9 ? "9+" : String(n);
        b.hidden = n === 0;
        const host = b.closest("button");
        if (host && host.dataset.label) host.setAttribute("aria-label", host.dataset.label + (n ? ` (${n} unread)` : ""));
      });
    }
    function render() {
      if (!data) return;
      const seen = isOpen ? seenWhenOpened : data.seen_at;
      if (!data.items.length) {
        o.list.innerHTML = `<div class="empty">No notifications yet. Every update on your packages will appear here.</div>`;
        return;
      }
      o.list.innerHTML = data.items.map(i => {
        const unread = !seen || new Date(i.posted_at) > new Date(seen);
        const where = [i.location, i.note].filter(Boolean).map(esc).join(" · ");
        return `<button type="button" class="n-item${unread ? " unread" : ""}" data-tn="${esc(i.tracking_no)}">
          ${icon(i.status)}
          <span class="n-main"><span class="n-title"><b>${esc(i.status)}</b><span class="mono">${esc(i.tracking_no)}</span></span>
            <span class="n-body">${esc(i.description || "Your package")}${where ? " · " + where : ""}</span></span>
          <span class="n-time">${ago(i.posted_at)}${unread ? '<span class="n-dot" aria-label="Unread"></span>' : ""}</span>
        </button>`;
      }).join("");
    }
    async function refresh() {
      try {
        const d = await o.load();
        if (d) {
          data = { seen_at: d.seen_at, items: d.items || [] };
          if (isOpen && needsMark) { seenWhenOpened = data.seen_at; needsMark = false; markRead(); }
          render(); paintBadges();
        }
      } catch {}
    }
    async function markRead() {
      if (!data || !unreadOf(data.seen_at)) return;
      try { const t = await o.markRead(); if (t) data.seen_at = t; } catch {}
      paintBadges();
    }
    o.list.addEventListener("click", e => { const b = e.target.closest(".n-item"); if (b && o.onOpen) o.onOpen(b.dataset.tn); });
    // Keep the count fresh while the page is open
    function schedule() { clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000); }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
    schedule(); refresh();

    return {
      refresh,
      opened() { isOpen = true; if (data) { seenWhenOpened = data.seen_at; render(); markRead(); } else needsMark = true; paintBadges(); },
      closed() { isOpen = false; needsMark = false; render(); paintBadges(); },
      markAll() { seenWhenOpened = new Date().toISOString(); render(); markRead(); },
      unread() { return unreadOf(data && data.seen_at); }
    };
  };
})();
