/**
 * APP SHELL — renders the sidebar/topbar chrome shared by every
 * authenticated user page (dashboard, earn, wallet, withdraw,
 * referrals, transactions, notifications, profile, help).
 */
import { requireAuth, logoutUser } from "./auth.js";
import { initTheme } from "./theme.js";
import { db } from "./firebase-init.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const NAV_ITEMS = [
  { href: "/dashboard.html", label: "Dashboard", icon: "grid" },
  { href: "/earn.html", label: "Earn", icon: "target" },
  { href: "/wallet.html", label: "Wallet", icon: "wallet" },
  { href: "/withdraw.html", label: "Withdraw", icon: "arrow-up-right" },
  { href: "/referrals.html", label: "Referrals", icon: "users" },
  { href: "/transactions.html", label: "Transactions", icon: "list" },
  { href: "/notifications.html", label: "Notifications", icon: "bell" },
  { href: "/profile.html", label: "Profile", icon: "user" },
  { href: "/help.html", label: "Help", icon: "help-circle" }
];

const ICONS = {
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5" fill="currentColor"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14" r="1" fill="currentColor"/>',
  "arrow-up-right": '<path d="M7 17L17 7M9 7h8v8"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3-6 7-6s7 2.7 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8.3 5 2.5 5 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bell: '<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  "help-circle": '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5"/><path d="M12 17h.01"/>'
};

function icon(name) {
  return `<svg class="te-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

/**
 * Mounts the sidebar + topbar into #te-shell-sidebar / #te-shell-topbar
 * (expected to already exist in the page's HTML) and enforces auth.
 * Returns { user, profile } once resolved, or null if redirected away.
 */
export async function mountAppShell({ activePath } = {}) {
  initTheme();
  const session = await requireAuth();
  if (!session) return null;
  const { user, profile } = session;

  const sidebar = document.getElementById("te-shell-sidebar");
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="te-sidebar-brand">
        <a href="/dashboard.html" class="te-sidebar-logo">TaskEarn</a>
      </div>
      <nav class="te-sidebar-nav" aria-label="Main navigation">
        ${NAV_ITEMS.map((item) => `
          <a href="${item.href}" class="te-nav-link${activePath === item.href ? " te-nav-link--active" : ""}">
            ${icon(item.icon)}<span>${item.label}</span>
            ${item.href === "/notifications.html" ? '<span id="te-nav-badge" class="te-nav-badge" hidden></span>' : ""}
          </a>`).join("")}
      </nav>
      <button type="button" class="te-nav-link te-nav-logout" id="te-logout-btn">
        ${icon("arrow-up-right")}<span>Log out</span>
      </button>`;
    document.getElementById("te-logout-btn").addEventListener("click", logoutUser);
  }

  const topbar = document.getElementById("te-shell-topbar");
  if (topbar) {
    topbar.innerHTML = `
      <button type="button" class="te-sidebar-toggle" id="te-sidebar-toggle" aria-label="Open menu">☰</button>
      <div class="te-topbar-spacer"></div>
      <button type="button" class="te-icon-btn" data-theme-toggle aria-label="Toggle dark mode">🌓</button>
      <div class="te-topbar-user">
        <span class="te-topbar-name">${profile.fullName || "Account"}</span>
        <span class="te-badge te-badge--${statusBadge(profile.status)}">${profile.status}</span>
      </div>`;
    document.getElementById("te-sidebar-toggle")?.addEventListener("click", () => {
      document.body.classList.toggle("te-sidebar-open");
    });
  }

  watchUnreadNotifications(user.uid);
  return session;
}

function statusBadge(status) {
  if (status === "active") return "active";
  if (status === "warning") return "warning";
  return "muted";
}

function watchUnreadNotifications(uid) {
  const badge = document.getElementById("te-nav-badge");
  if (!badge) return;
  const q = query(collection(db, "notifications"), where("userId", "==", uid), where("read", "==", false));
  onSnapshot(q, (snap) => {
    if (snap.size > 0) {
      badge.hidden = false;
      badge.textContent = snap.size > 9 ? "9+" : String(snap.size);
    } else {
      badge.hidden = true;
    }
  }, (err) => console.warn("Notification watch failed:", err.code));
}
