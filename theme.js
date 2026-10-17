/* JustBuy light / dark switch.
   Load in <head> (not deferred) so the saved choice applies before the page paints.
   Adds a toggle button into every element marked data-theme-slot. */
(function () {
  var KEY = "justbuy-theme";
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return mq && mq.matches ? "dark" : "light";
  }
  var SUN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg>';

  function paint(btn) {
    var dark = current() === "dark";
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.title = dark ? "Light mode" : "Dark mode";
  }
  function all() { return document.querySelectorAll(".theme-toggle"); }
  function set(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    all().forEach(paint);
  }

  function mount() {
    var css = document.createElement("style");
    css.textContent =
      ".theme-toggle{display:inline-grid;place-items:center;width:38px;height:38px;flex:none;border-radius:10px;" +
      "border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer;padding:0}" +
      ".theme-toggle:hover{border-color:var(--muted)}" +
      ".theme-toggle:focus-visible{outline:3px solid color-mix(in srgb,var(--brand) 40%,transparent);outline-offset:2px}";
    document.head.appendChild(css);
    document.querySelectorAll("[data-theme-slot]").forEach(function (slot) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "theme-toggle";
      b.addEventListener("click", function () { set(current() === "dark" ? "light" : "dark"); });
      paint(b); slot.appendChild(b);
    });
    if (mq && mq.addEventListener) mq.addEventListener("change", function () { all().forEach(paint); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
