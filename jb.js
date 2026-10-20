/* JustBuy UI helpers: segmented controls get a thumb that slides to the selected
   segment (selected = aria-selected="true", aria-pressed="true" or .on).
   The thumb animates with a critically damped curve from wherever it is now, so
   quick repeated taps redirect it smoothly instead of restarting. */
(function () {
  function selected(seg) {
    return seg.querySelector(':scope > [aria-selected="true"], :scope > [aria-pressed="true"], :scope > .on');
  }
  function place(seg) {
    var thumb = seg.querySelector(":scope > .seg-thumb");
    var btn = selected(seg);
    if (!thumb) return;
    if (!btn || !btn.offsetWidth) { thumb.style.opacity = "0"; return; }
    thumb.style.opacity = "1";
    thumb.style.width = btn.offsetWidth + "px";
    thumb.style.transform = "translateX(" + btn.offsetLeft + "px)";
  }
  function init(seg) {
    if (seg.__jb) return; seg.__jb = true;
    var thumb = document.createElement("span");
    thumb.className = "seg-thumb"; thumb.setAttribute("aria-hidden", "true");
    seg.insertBefore(thumb, seg.firstChild);
    place(seg);
    requestAnimationFrame(function () { requestAnimationFrame(function () { seg.classList.add("ready"); }); });
    new MutationObserver(function () { place(seg); })
      .observe(seg, { subtree: true, attributes: true, attributeFilter: ["class", "aria-selected", "aria-pressed", "hidden"] });
    if (window.ResizeObserver) new ResizeObserver(function () { place(seg); }).observe(seg);
  }
  function scan(root) { (root || document).querySelectorAll(".seg").forEach(init); }
  var FLAGS = {
    cn: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#de2910"/><path fill="#ffde00" d="M5 3l.9 2.7h2.9L6.5 7.4l.9 2.7L5 8.4 2.6 10.1l.9-2.7L1.2 5.7h2.9z"/><g fill="#ffde00"><circle cx="10" cy="2.6" r=".75"/><circle cx="12" cy="4.6" r=".75"/><circle cx="12" cy="7.4" r=".75"/><circle cx="10" cy="9.4" r=".75"/></g></svg>',
    us: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#fff"/><g fill="#b22234"><rect y="0" width="30" height="1.54"/><rect y="3.08" width="30" height="1.54"/><rect y="6.16" width="30" height="1.54"/><rect y="9.24" width="30" height="1.54"/><rect y="12.32" width="30" height="1.54"/><rect y="15.4" width="30" height="1.54"/><rect y="18.48" width="30" height="1.52"/></g><rect width="12" height="10.78" fill="#3c3b6e"/><g fill="#fff"><circle cx="2" cy="2" r=".55"/><circle cx="5" cy="2" r=".55"/><circle cx="8" cy="2" r=".55"/><circle cx="10.5" cy="2" r=".55"/><circle cx="3.5" cy="4.2" r=".55"/><circle cx="6.5" cy="4.2" r=".55"/><circle cx="9.3" cy="4.2" r=".55"/><circle cx="2" cy="6.4" r=".55"/><circle cx="5" cy="6.4" r=".55"/><circle cx="8" cy="6.4" r=".55"/><circle cx="10.5" cy="6.4" r=".55"/><circle cx="3.5" cy="8.6" r=".55"/><circle cx="6.5" cy="8.6" r=".55"/><circle cx="9.3" cy="8.6" r=".55"/></g></svg>',
    uk: '<svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" stroke="#c8102e" stroke-width="3"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="12"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="7"/></svg>'
  };
  window.JB = {
    refreshSegments: function () { document.querySelectorAll(".seg").forEach(place); }, scan: scan,
    flag: function (id) { var f = FLAGS[String(id || "").toLowerCase()]; return f ? '<span class="flag" aria-hidden="true">' + f + "</span>" : ""; },
    isCJK: function (s) { return /[\u3400-\u9fff]/.test(String(s || "")); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { scan(); }); else scan();
  // Segments inside views that were hidden get their size once shown.
  window.addEventListener("load", function () { JB.refreshSegments(); });
})();
