/**
 * THEME — light/dark mode toggle. Default: light.
 */
const STORAGE_KEY = "te-theme";

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const theme = saved || "light";
  applyTheme(theme);

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-theme-toggle]");
    if (!toggle) return;
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "light" ? "dark" : "light");
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
    btn.setAttribute("aria-pressed", String(theme === "dark"));
  });
}
