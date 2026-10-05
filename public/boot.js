// Runs before the app bundle so the first frame already has the right theme.
(function () {
  var root = document.documentElement;
  var ua = navigator.userAgent;
  var platform = /Mac|iPhone|iPad/.test(navigator.platform || ua) ? "mac" : /Win/.test(navigator.platform || ua) ? "windows" : "linux";
  root.dataset.platform = platform;
  root.dataset.shell = "__TAURI_INTERNALS__" in window ? "desktop" : "web";
  var settings = {};
  var version = 0;
  try {
    var raw = localStorage.getItem("margin:prefs");
    if (raw) {
      var saved = JSON.parse(raw);
      settings = (saved.state || {}).settings || {};
      version = saved.version || 0;
    }
  } catch (e) {}
  var accent = settings.accent;
  if (!accent || (version < 4 && accent === "vermilion")) accent = "amber";
  var pref = settings.theme || "system";
  var dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.accent = accent;
  root.dataset.material = "off";
})();
