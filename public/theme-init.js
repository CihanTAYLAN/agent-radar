// Applies the saved theme before first paint (loaded synchronously in <head>; CSP forbids inline scripts).
try {
  const t = localStorage.getItem("radar.theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch {
  /* storage unavailable: follow prefers-color-scheme */
}
