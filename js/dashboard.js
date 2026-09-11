import { mountAppShell } from "./app.js";
import { db } from "./firebase-init.js";
import {
  collection, query, where, orderBy, limit, onSnapshot, doc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatCurrency, formatDate, escapeHTML, renderEmpty } from "./utils.js";

const session = await mountAppShell({ activePath: "/dashboard.html" });
if (session) {
  const { user, profile } = session;
  document.getElementById("greeting").textContent = `Welcome back, ${profile.fullName?.split(" ")[0] || "there"}`;

  // Live user doc → stat cards (balance/earned/etc. are server-trusted fields).
  onSnapshot(doc(db, "users", user.uid), (snap) => {
    if (!snap.exists()) return;
    renderStats(snap.data());
  });

  // Pending withdrawals count for this user.
  let pendingWithdrawals = 0;
  onSnapshot(
    query(collection(db, "withdrawals"), where("userId", "==", user.uid), where("status", "==", "pending")),
    (snap) => { pendingWithdrawals = snap.size; document.getElementById("stat-pending-withdrawals")?.replaceChildren(document.createTextNode(String(pendingWithdrawals))); }
  );

  // Recent transactions.
  onSnapshot(
    query(collection(db, "transactions"), where("userId", "==", user.uid), orderBy("createdAt", "desc"), limit(6)),
    (snap) => renderTransactions(snap.docs.map((d) => d.data()))
  );

  // Active campaigns (client filters by country/date; server also enforces on postback).
  onSnapshot(
    query(collection(db, "campaigns"), where("status", "==", "active"), orderBy("priority", "desc"), limit(6)),
    (snap) => renderCampaigns(snap.docs.map((d) => ({ id: d.id, ...d.data() })), profile.country)
  );

  // Active announcements.
  onSnapshot(collection(db, "announcements"), (snap) => {
    const now = Date.now();
    const active = snap.docs
      .map((d) => d.data())
      .filter((a) => a.active !== false && (!a.endDate || toMillis(a.endDate) > now));
    renderAnnouncement(active[0]);
  });
}

function toMillis(ts) {
  return ts?.toMillis ? ts.toMillis() : new Date(ts).getTime();
}

function renderStats(u) {
  const grid = document.getElementById("stat-grid");
  grid.innerHTML = `
    <div class="te-stat-card te-stat-card--coin"><div class="te-stat-label">Current balance</div><div class="te-stat-value">${formatCurrency(u.balance)}</div></div>
    <div class="te-stat-card"><div class="te-stat-label">Total earned</div><div class="te-stat-value">${formatCurrency(u.totalEarned)}</div></div>
    <div class="te-stat-card"><div class="te-stat-label">Total withdrawn</div><div class="te-stat-value">${formatCurrency(u.totalWithdrawn)}</div></div>
    <div class="te-stat-card"><div class="te-stat-label">Referral earnings</div><div class="te-stat-value">${formatCurrency(u.totalReferralEarned)}</div></div>
    <div class="te-stat-card"><div class="te-stat-label">Account status</div><div class="te-stat-value" style="font-size:1.1rem; text-transform:capitalize;">${escapeHTML(u.status)}</div></div>
    <div class="te-stat-card"><div class="te-stat-label">Pending withdrawals</div><div class="te-stat-value" id="stat-pending-withdrawals">—</div></div>`;
}

function renderTransactions(list) {
  const tbody = document.getElementById("recent-transactions");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="4" class="te-text-muted">No transactions yet — completed tasks will show up here.</td></tr>`; return; }
  tbody.innerHTML = list.map((t) => `
    <tr>
      <td>${formatDate(t.createdAt)}</td>
      <td>${escapeHTML(labelForType(t.type))}</td>
      <td class="${t.amount >= 0 ? "te-text-coin" : ""}">${t.amount >= 0 ? "+" : ""}${formatCurrency(Math.abs(t.amount))}</td>
      <td><span class="te-badge te-badge--${badgeForStatus(t.status)}">${escapeHTML(t.status)}</span></td>
    </tr>`).join("");
}

function renderCampaigns(campaigns, userCountry) {
  const grid = document.getElementById("featured-campaigns");
  const eligible = campaigns.filter((c) => !c.allowedCountries?.length || c.allowedCountries.includes(userCountry));
  if (!eligible.length) { renderEmpty(grid, "No tasks available right now.", "Check back soon — new tasks are added regularly."); return; }
  grid.innerHTML = eligible.map((c) => `
    <a class="te-campaign-card" href="/campaign.html?id=${encodeURIComponent(c.id)}" style="text-decoration:none;">
      <span class="te-badge te-badge--muted" style="align-self:flex-start;">${escapeHTML(c.category || "Task")}</span>
      <h3 style="margin:4px 0 0;">${escapeHTML(c.title)}</h3>
      <span class="te-campaign-reward">${formatCurrency(c.reward)}</span>
    </a>`).join("");
}

function renderAnnouncement(a) {
  const slot = document.getElementById("announcement-slot");
  if (!a) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="te-announcement"><strong>${escapeHTML(a.title)}</strong>${escapeHTML(a.message)}</div>`;
}

function labelForType(type) {
  const map = {
    campaign_reward: "Task reward", referral_reward: "Referral commission", bonus: "Bonus",
    withdrawal: "Withdrawal", withdrawal_reversal: "Withdrawal reversed", admin_adjustment: "Adjustment"
  };
  return map[type] || type;
}
function badgeForStatus(status) {
  if (["completed", "approved", "paid"].includes(status)) return "active";
  if (status === "pending" || status === "processing") return "pending";
  if (status === "rejected") return "rejected";
  return "muted";
}
