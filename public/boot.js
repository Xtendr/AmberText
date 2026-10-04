// Runs before the app bundle so the first frame already has the right theme.
(function () {
  var root = document.documentElement;
  var ua = navigator.userAgent;
  var platform = /Mac|iPhone|iPad/.test(navigator.platform || ua) ? "mac" : /Win/.test(navigator.platform || ua) ? "windows" : "linux";
  root.dataset.platform = platform;
  var settings = {};
  try {
    var raw = localStorage.getItem("margin:prefs");
    if (raw) settings = (JSON.parse(raw).state || {}).settings || {};
  } catch (e) {}
  var pref = settings.theme || "system";
  var dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.accent = settings.accent || "vermilion";
  root.dataset.material = "off";
})();
