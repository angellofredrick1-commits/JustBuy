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
  window.JB = { refreshSegments: function () { document.querySelectorAll(".seg").forEach(place); }, scan: scan };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { scan(); }); else scan();
  // Segments inside views that were hidden get their size once shown.
  window.addEventListener("load", function () { JB.refreshSegments(); });
})();
