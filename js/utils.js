/**
 * UTILS — shared helpers used across every page.
 * No Firebase imports here; this module must stay dependency-free
 * so it can be unit-tested in isolation.
 */

// ---------- Formatting ----------

export function formatCurrency(amount, symbol = "৳") {
  const n = Number(amount) || 0;
  return `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

export function timeAgo(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  const steps = [
    [31536000, "year"], [2592000, "month"], [86400, "day"],
    [3600, "hour"], [60, "minute"]
  ];
  for (const [secs, label] of steps) {
    const val = Math.floor(seconds / secs);
    if (val >= 1) return `${val} ${label}${val > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

export function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

// ---------- Validation ----------

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function passwordStrength(password) {
  if (!password || password.length < 8) return { ok: false, message: "At least 8 characters" };
  if (!/[A-Z]/.test(password)) return { ok: false, message: "Add an uppercase letter" };
  if (!/[0-9]/.test(password)) return { ok: false, message: "Add a number" };
  return { ok: true, message: "Strong password" };
}

export function isValidPhone(phone) {
  return /^\+?[0-9\s-]{7,15}$/.test(phone);
}

// ---------- Toast notifications ----------

let toastContainer = null;
function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "te-toast-container";
    toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

export function showToast(message, type = "info", duration = 4000) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `te-toast te-toast--${type}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("te-toast--visible"));
  setTimeout(() => {
    toast.classList.remove("te-toast--visible");
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ---------- Confirmation dialog (for destructive actions) ----------

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "te-modal-overlay";
    overlay.innerHTML = `
      <div class="te-modal" role="alertdialog" aria-modal="true" aria-labelledby="te-modal-title">
        <h3 id="te-modal-title">${escapeHTML(title)}</h3>
        <p>${escapeHTML(message)}</p>
        <div class="te-modal-actions">
          <button type="button" class="te-btn te-btn--ghost" data-action="cancel">Cancel</button>
          <button type="button" class="te-btn ${danger ? "te-btn--danger" : "te-btn--primary"}" data-action="confirm">${escapeHTML(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => cleanup(false));
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('[data-action="confirm"]').focus();
  });
}

// ---------- Loading / empty / error state helpers ----------

export function renderLoading(container, message = "Loading…") {
  container.innerHTML = `<div class="te-state te-state--loading"><div class="te-spinner" aria-hidden="true"></div><p>${escapeHTML(message)}</p></div>`;
}

export function renderEmpty(container, message = "Nothing here yet.", hint = "") {
  container.innerHTML = `<div class="te-state te-state--empty"><p>${escapeHTML(message)}</p>${hint ? `<p class="te-state-hint">${escapeHTML(hint)}</p>` : ""}</div>`;
}

export function renderError(container, message = "Something went wrong. Please try again.") {
  container.innerHTML = `<div class="te-state te-state--error"><p>${escapeHTML(message)}</p></div>`;
}

// ---------- Query params ----------

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// ---------- Friendly Firebase error messages ----------

export function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/weak-password": "Please choose a stronger password.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed": "Network error. Check your connection and try again."
  };
  return map[code] || "Something went wrong. Please try again.";
}
