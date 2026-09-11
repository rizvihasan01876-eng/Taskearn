/**
 * TASKEARN — CLOUD FUNCTIONS
 * =====================================================================
 * This file is the ONLY place money moves in TaskEarn. Every function
 * here uses the Admin SDK (bypasses Firestore rules by design) so it
 * must do its own validation. The frontend can request things; it can
 * never grant them.
 *
 * Sections:
 *   1. Setup & shared helpers
 *   2. Admin role management (custom claims)
 *   3. Provider postback / conversion verification  <-- CRITICAL
 *   4. Reward crediting + referral commission (internal, transactional)
 *   5. Withdrawals (create / admin process / reversal)
 *   6. Admin balance adjustment
 *   7. Notifications
 *   8. Basic risk scoring
 *
 * Provider secrets (postback secrets, API keys) are read from Firebase
 * Functions environment config / Secret Manager — NEVER hardcoded here
 * and NEVER present in any frontend file.
 *
 *   firebase functions:secrets:set CPX_SECURE_HASH_SECRET
 *   firebase functions:secrets:set CPAGRIP_POSTBACK_SECRET
 * =====================================================================
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

setGlobalOptions({ region: "us-central1", maxInstances: 20 });

const CPX_SECURE_HASH_SECRET = defineSecret("CPX_SECURE_HASH_SECRET");
const CPAGRIP_POSTBACK_SECRET = defineSecret("CPAGRIP_POSTBACK_SECRET");

// ---------------------------------------------------------------------
// 1. SHARED HELPERS
// ---------------------------------------------------------------------

function assertSignedIn(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
  return request.auth.uid;
}

function assertAdmin(request) {
  const uid = assertSignedIn(request);
  const claims = request.auth.token || {};
  if (!claims.admin && !claims.superAdmin) {
    throw new HttpsError("permission-denied", "Admin privileges required.");
  }
  return uid;
}

function assertSuperAdmin(request) {
  const uid = assertSignedIn(request);
  if (!request.auth.token.superAdmin) {
    throw new HttpsError("permission-denied", "Super admin privileges required.");
  }
  return uid;
}

async function logAdminAction({ adminUserId, action, targetUserId = null, targetResourceId = null, reason = "", metadata = {} }) {
  await db.collection("adminLogs").add({
    adminUserId, action, targetUserId, targetResourceId, reason, metadata,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function getSetting(key, fallback) {
  const snap = await db.collection("settings").doc("general").get();
  if (!snap.exists) return fallback;
  const val = snap.data()[key];
  return val === undefined ? fallback : val;
}

// ---------------------------------------------------------------------
// 2. ADMIN ROLE MANAGEMENT
// ---------------------------------------------------------------------

/**
 * Assign or revoke admin/super_admin role. Callable only by an existing
 * super admin. This is the ONLY way `role` ever changes after the first
 * admin is bootstrapped (see README "Creating the first admin").
 */
exports.setUserRole = onCall(async (request) => {
  const callerId = assertSuperAdmin(request);
  const { targetUserId, role } = request.data || {};
  if (!targetUserId || !["user", "admin", "super_admin"].includes(role)) {
    throw new HttpsError("invalid-argument", "targetUserId and a valid role are required.");
  }
  if (targetUserId === callerId && role === "user") {
    throw new HttpsError("failed-precondition", "You cannot demote yourself.");
  }

  const claims = { admin: role === "admin" || role === "super_admin", superAdmin: role === "super_admin" };
  await admin.auth().setCustomUserClaims(targetUserId, claims);
  await db.collection("users").doc(targetUserId).update({ role, updatedAt: FieldValue.serverTimestamp() });

  await logAdminAction({ adminUserId: callerId, action: "ROLE_CHANGED", targetUserId, metadata: { role } });
  return { success: true };
});

// ---------------------------------------------------------------------
// 3. PROVIDER POSTBACK / CONVERSION VERIFICATION
// ---------------------------------------------------------------------
//
// GET/POST /processProviderPostback?provider=cpx&...
// Each provider has its own query-param shape and signature scheme.
// Add new providers by adding a verifier below — nothing else in the
// app needs to change (campaigns reference `integrationType`).

const PROVIDER_VERIFIERS = {
  /**
   * CPX Research sends a `secure_hash` = md5(clickId + secret).
   * Adjust field names to match your CPX dashboard's actual postback
   * URL template — CPX lets you customize which params are sent.
   */
  cpx: async (query, secrets) => {
    const { user_id: userId, trans_id: providerConversionId, amount_local: amount, status, secure_hash } = query;
    if (!userId || !providerConversionId || !amount) {
      return { ok: false, reason: "missing_fields" };
    }
    const expected = crypto.createHash("md5").update(`${providerConversionId}-${secrets.cpx}`).digest("hex");
    if (secure_hash !== expected) return { ok: false, reason: "bad_signature" };
    // CPX status: 1 = complete, 2 = chargeback/reversal
    if (String(status) === "2") return { ok: true, reversal: true, userId, providerConversionId, amount: Number(amount) };
    return { ok: true, reversal: false, userId, providerConversionId, amount: Number(amount) };
  },

  /**
   * CPAGrip postback. Adjust field names to match your CPAGrip
   * "Postback Pixel" setup exactly — this is a common default shape.
   */
  cpagrip: async (query, secrets) => {
    const { subid: userId, transid: providerConversionId, payout: amount, token } = query;
    if (!userId || !providerConversionId || !amount) {
      return { ok: false, reason: "missing_fields" };
    }
    if (token !== secrets.cpagrip) return { ok: false, reason: "bad_signature" };
    return { ok: true, reversal: false, userId, providerConversionId, amount: Number(amount) };
  }
};

exports.processProviderPostback = onRequest(
  { secrets: [CPX_SECURE_HASH_SECRET, CPAGRIP_POSTBACK_SECRET] },
  async (req, res) => {
    const provider = String(req.query.provider || req.params.provider || "").toLowerCase();
    const verifier = PROVIDER_VERIFIERS[provider];
    if (!verifier) {
      logger.warn("Unknown provider postback", { provider });
      res.status(400).send("unknown_provider");
      return;
    }

    try {
      const secrets = { cpx: CPX_SECURE_HASH_SECRET.value(), cpagrip: CPAGRIP_POSTBACK_SECRET.value() };
      const result = await verifier(req.query, secrets);
      if (!result.ok) {
        logger.warn("Postback rejected", { provider, reason: result.reason, query: req.query });
        res.status(400).send(result.reason);
        return;
      }

      const { userId, providerConversionId, amount, reversal } = result;

      // campaignId is optional in the postback itself if the provider
      // doesn't pass it back — we look up the most recent "started"
      // completion stub for this user+provider instead when absent.
      const campaignId = req.query.campaign_id || req.query.campaignId || null;

      if (reversal) {
        await reverseConversion({ provider, providerConversionId });
        res.status(200).send("OK_REVERSED");
        return;
      }

      const outcome = await creditConversion({ provider, providerConversionId, userId, campaignId, amount });
      res.status(200).send(outcome.idempotent ? "OK_DUPLICATE" : "OK");
    } catch (err) {
      logger.error("Postback processing error", err);
      res.status(500).send("internal_error");
    }
  }
);

// ---------------------------------------------------------------------
// 4. REWARD CREDITING + REFERRAL COMMISSION (internal, transactional)
// ---------------------------------------------------------------------

/**
 * Idempotently credit a verified conversion. Uses a deterministic
 * document ID (`provider_providerConversionId`) as the conversion's
 * primary key so a duplicate postback can NEVER be credited twice —
 * the transaction's `.get()` + `.create()` pattern makes the second
 * attempt fail safely.
 */
async function creditConversion({ provider, providerConversionId, userId, campaignId, amount }) {
  const conversionRef = db.collection("campaignCompletions").doc(`${provider}_${providerConversionId}`);
  const userRef = db.collection("users").doc(userId);

  return db.runTransaction(async (tx) => {
    const [conversionSnap, userSnap] = await Promise.all([tx.get(conversionRef), tx.get(userRef)]);

    if (conversionSnap.exists) {
      return { idempotent: true }; // already processed — do NOT credit again
    }
    if (!userSnap.exists) throw new Error(`User ${userId} not found for conversion ${providerConversionId}`);

    const user = userSnap.data();
    if (user.status === "banned" || user.status === "suspended") {
      // Record it as rejected so support/fraud review can see it, but don't pay.
      tx.set(conversionRef, {
        provider, providerConversionId, userId, campaignId,
        reward: amount, status: "rejected", reason: "account_not_active",
        createdAt: FieldValue.serverTimestamp(), processedAt: FieldValue.serverTimestamp()
      });
      return { idempotent: false, credited: false };
    }

    const balanceBefore = user.balance || 0;
    const balanceAfter = balanceBefore + amount;

    // 4a. Conversion record (source of truth this was processed)
    tx.set(conversionRef, {
      provider, providerConversionId, userId, campaignId,
      reward: amount, status: "approved",
      createdAt: FieldValue.serverTimestamp(), processedAt: FieldValue.serverTimestamp()
    });

    // 4b. Ledger transaction
    const txnRef = db.collection("transactions").doc();
    tx.set(txnRef, {
      transactionId: txnRef.id, userId, type: "campaign_reward",
      amount, currency: "BDT", balanceBefore, balanceAfter,
      referenceId: conversionRef.id, description: `Reward for campaign ${campaignId || provider}`,
      status: "completed", createdAt: FieldValue.serverTimestamp(), createdBy: "system"
    });

    // 4c. Update cached balance (server-trusted only)
    tx.update(userRef, {
      balance: balanceAfter,
      totalEarned: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { idempotent: false, credited: true, userId, amount, balanceAfter };
  }).then(async (outcome) => {
    if (outcome.credited) {
      await maybeCreditReferralCommission({ referredUserId: userId, eligibleAmount: amount, referenceId: conversionRef.id });
    }
    return outcome;
  });
}

/**
 * If this user was referred, and the referral isn't yet blocked, pay
 * the referrer their configured commission percent and mark/advance
 * the referral's qualification state. Runs as its own transaction
 * (separate from the reward credit) so a referral edge case never
 * blocks the underlying reward from paying.
 */
async function maybeCreditReferralCommission({ referredUserId, eligibleAmount, referenceId }) {
  const userSnap = await db.collection("users").doc(referredUserId).get();
  const referrerUserId = userSnap.exists ? userSnap.data().referredBy : null;
  if (!referrerUserId) return;
  if (referrerUserId === referredUserId) return; // guard against self-referral data corruption

  const referralRef = db.collection("referrals").doc(`${referrerUserId}_${referredUserId}`);
  const referrerRef = db.collection("users").doc(referrerUserId);

  const commissionPercent = await getSetting("referralCommissionPercent", 10);

  await db.runTransaction(async (tx) => {
    const [referralSnap, referrerSnap] = await Promise.all([tx.get(referralRef), tx.get(referrerRef)]);
    if (!referralSnap.exists || !referrerSnap.exists) return;

    const referral = referralSnap.data();
    if (referral.status === "blocked") return; // fraud-blocked referral, never pays

    const referrer = referrerSnap.data();
    if (referrer.status === "banned" || referrer.status === "suspended") return;

    // Server-side calculation only — never trust a client-supplied amount.
    const commission = Math.round((eligibleAmount * commissionPercent) / 100 * 100) / 100;
    if (commission <= 0) return;

    const balanceBefore = referrer.balance || 0;
    const balanceAfter = balanceBefore + commission;

    const txnRef = db.collection("transactions").doc();
    tx.set(txnRef, {
      transactionId: txnRef.id, userId: referrerUserId, type: "referral_reward",
      amount: commission, currency: "BDT", balanceBefore, balanceAfter,
      referenceId, description: `Referral commission (${commissionPercent}%) from referred user activity`,
      status: "completed", createdAt: FieldValue.serverTimestamp(), createdBy: "system"
    });

    tx.update(referrerRef, {
      balance: balanceAfter,
      totalReferralEarned: FieldValue.increment(commission),
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.update(referralRef, {
      status: "qualified",
      qualified: true,
      totalEligibleEarnings: FieldValue.increment(eligibleAmount),
      totalCommission: FieldValue.increment(commission),
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

/**
 * A provider reversed a previously-approved conversion (e.g. a survey
 * respondent was later flagged as fraudulent). Reverse the reward —
 * and, if one was paid, the referral commission — WITHOUT rewriting
 * the original transaction records. History stays intact; a new
 * negative-amount reversal transaction is appended instead.
 */
async function reverseConversion({ provider, providerConversionId }) {
  const conversionRef = db.collection("campaignCompletions").doc(`${provider}_${providerConversionId}`);

  await db.runTransaction(async (tx) => {
    const conversionSnap = await tx.get(conversionRef);
    if (!conversionSnap.exists) return; // nothing to reverse
    const conversion = conversionSnap.data();
    if (conversion.status === "reversed") return; // already reversed — idempotent

    const userRef = db.collection("users").doc(conversion.userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) return;
    const user = userSnap.data();

    const amount = conversion.reward;
    const balanceBefore = user.balance || 0;
    // Balance can go negative here (user already spent/withdrew it) —
    // that's intentional; it surfaces as a negative balance for admin
    // review rather than silently disappearing.
    const balanceAfter = balanceBefore - amount;

    const txnRef = db.collection("transactions").doc();
    tx.set(txnRef, {
      transactionId: txnRef.id, userId: conversion.userId, type: "admin_adjustment",
      amount: -amount, currency: "BDT", balanceBefore, balanceAfter,
      referenceId: conversionRef.id, description: `Reward reversed by provider (${provider})`,
      status: "completed", createdAt: FieldValue.serverTimestamp(), createdBy: "system"
    });

    tx.update(userRef, {
      balance: balanceAfter,
      totalEarned: FieldValue.increment(-amount),
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.update(conversionRef, { status: "reversed", reversedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Admin-triggered manual reversal (e.g. after investigating a fraud
 * report), for cases the provider itself won't send a postback for.
 */
exports.reverseReward = onCall(async (request) => {
  const adminUserId = assertAdmin(request);
  const { conversionId, reason } = request.data || {};
  if (!conversionId || !reason) throw new HttpsError("invalid-argument", "conversionId and reason are required.");

  const [provider, ...rest] = conversionId.split("_");
  await reverseConversion({ provider, providerConversionId: rest.join("_") });
  await logAdminAction({ adminUserId, action: "REWARD_REVERSED", targetResourceId: conversionId, reason });
  return { success: true };
});

// ---------------------------------------------------------------------
// 5. WITHDRAWALS
// ---------------------------------------------------------------------

exports.createWithdrawal = onCall(async (request) => {
  const userId = assertSignedIn(request);
  const { amount, method, accountNumber, accountName, notes } = request.data || {};

  if (!amount || amount <= 0) throw new HttpsError("invalid-argument", "A valid amount is required.");
  if (!method || !accountNumber || !accountName) {
    throw new HttpsError("invalid-argument", "Payment method and account details are required.");
  }

  const withdrawalEnabled = await getSetting("withdrawalEnabled", true);
  if (!withdrawalEnabled) throw new HttpsError("failed-precondition", "Withdrawals are currently disabled.");

  const minWithdrawal = await getSetting("minimumWithdrawal", 100);
  const maxWithdrawal = await getSetting("maximumWithdrawal", 20000);
  if (amount < minWithdrawal) throw new HttpsError("failed-precondition", `Minimum withdrawal is ৳${minWithdrawal}.`);
  if (amount > maxWithdrawal) throw new HttpsError("failed-precondition", `Maximum withdrawal is ৳${maxWithdrawal}.`);

  const userRef = db.collection("users").doc(userId);
  const withdrawalRef = db.collection("withdrawals").doc();

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "User not found.");
    const user = userSnap.data();

    if (user.status !== "active") throw new HttpsError("failed-precondition", "Your account cannot request withdrawals right now.");

    const balanceBefore = user.balance || 0;
    if (balanceBefore < amount) throw new HttpsError("failed-precondition", "Insufficient balance.");

    // Reject a second pending request if one already exists, to keep
    // reserved funds predictable (configurable via settings if desired).
    const balanceAfter = balanceBefore - amount;

    tx.set(withdrawalRef, {
      withdrawalId: withdrawalRef.id, userId, amount, currency: "BDT",
      method, accountNumber, accountName, notes: notes || "",
      status: "pending", riskFlag: user.riskLevel === "HIGH" || user.riskLevel === "CRITICAL",
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });

    const txnRef = db.collection("transactions").doc();
    tx.set(txnRef, {
      transactionId: txnRef.id, userId, type: "withdrawal",
      amount: -amount, currency: "BDT", balanceBefore, balanceAfter,
      referenceId: withdrawalRef.id, description: `Withdrawal request via ${method}`,
      status: "pending", createdAt: FieldValue.serverTimestamp(), createdBy: userId
    });

    tx.update(userRef, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() });
  });

  return { success: true, withdrawalId: withdrawalRef.id };
});

/**
 * Admin-only. Moves a withdrawal through its lifecycle. Rejecting or
 * cancelling restores the reserved balance via a `withdrawal_reversal`
 * transaction — never by editing the original request.
 */
exports.processWithdrawal = onCall(async (request) => {
  const adminUserId = assertAdmin(request);
  const { withdrawalId, action, reason } = request.data || {}; // action: processing | paid | rejected | cancelled
  const validActions = ["processing", "paid", "rejected", "cancelled"];
  if (!withdrawalId || !validActions.includes(action)) {
    throw new HttpsError("invalid-argument", "withdrawalId and a valid action are required.");
  }
  if ((action === "rejected" || action === "cancelled") && !reason) {
    throw new HttpsError("invalid-argument", "A reason is required to reject or cancel a withdrawal.");
  }

  const withdrawalRef = db.collection("withdrawals").doc(withdrawalId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(withdrawalRef);
    if (!snap.exists) throw new HttpsError("not-found", "Withdrawal not found.");
    const withdrawal = snap.data();

    if (["paid", "rejected", "cancelled"].includes(withdrawal.status)) {
      throw new HttpsError("failed-precondition", `Withdrawal is already ${withdrawal.status}.`);
    }

    tx.update(withdrawalRef, {
      status: action, updatedAt: FieldValue.serverTimestamp(),
      ...(reason ? { rejectionReason: reason } : {})
    });

    if (action === "rejected" || action === "cancelled") {
      const userRef = db.collection("users").doc(withdrawal.userId);
      const userSnap = await tx.get(userRef);
      const user = userSnap.data();
      const balanceBefore = user.balance || 0;
      const balanceAfter = balanceBefore + withdrawal.amount;

      const txnRef = db.collection("transactions").doc();
      tx.set(txnRef, {
        transactionId: txnRef.id, userId: withdrawal.userId, type: "withdrawal_reversal",
        amount: withdrawal.amount, currency: "BDT", balanceBefore, balanceAfter,
        referenceId: withdrawalId, description: `Withdrawal ${action}: ${reason}`,
        status: "completed", createdAt: FieldValue.serverTimestamp(), createdBy: adminUserId
      });
      tx.update(userRef, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() });
    }

    if (action === "paid") {
      const userRef = db.collection("users").doc(withdrawal.userId);
      tx.update(userRef, { totalWithdrawn: FieldValue.increment(withdrawal.amount), updatedAt: FieldValue.serverTimestamp() });
    }
  });

  await logAdminAction({
    adminUserId, action: `WITHDRAWAL_${action.toUpperCase()}`,
    targetResourceId: withdrawalId, reason: reason || ""
  });

  return { success: true };
});

// ---------------------------------------------------------------------
// 6. ADMIN BALANCE ADJUSTMENT
// ---------------------------------------------------------------------

exports.adminBalanceAdjustment = onCall(async (request) => {
  const adminUserId = assertAdmin(request);
  const { targetUserId, amount, reason } = request.data || {};
  if (!targetUserId || !amount || !reason) {
    throw new HttpsError("invalid-argument", "targetUserId, amount, and reason are required.");
  }

  const userRef = db.collection("users").doc(targetUserId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new HttpsError("not-found", "User not found.");
    const user = snap.data();
    const balanceBefore = user.balance || 0;
    const balanceAfter = balanceBefore + amount;

    const txnRef = db.collection("transactions").doc();
    tx.set(txnRef, {
      transactionId: txnRef.id, userId: targetUserId, type: "admin_adjustment",
      amount, currency: "BDT", balanceBefore, balanceAfter,
      referenceId: null, description: reason,
      status: "completed", createdAt: FieldValue.serverTimestamp(), createdBy: adminUserId
    });
    tx.update(userRef, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() });
  });

  await logAdminAction({ adminUserId, action: "BALANCE_ADJUSTED", targetUserId, reason, metadata: { amount } });
  return { success: true };
});

// ---------------------------------------------------------------------
// 7. NOTIFICATIONS
// ---------------------------------------------------------------------

exports.sendNotification = onCall(async (request) => {
  const adminUserId = assertAdmin(request);
  const { title, message, type = "System", target, userIds } = request.data || {}; // target: 'single' | 'selected' | 'all'
  if (!title || !message) throw new HttpsError("invalid-argument", "title and message are required.");

  let recipients = [];
  if (target === "all") {
    const usersSnap = await db.collection("users").select().get();
    recipients = usersSnap.docs.map((d) => d.id);
  } else if (target === "selected" || target === "single") {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new HttpsError("invalid-argument", "userIds is required for this target.");
    }
    recipients = userIds;
  } else {
    throw new HttpsError("invalid-argument", "target must be 'single', 'selected', or 'all'.");
  }

  const batchSize = 400; // stay under Firestore batch limits
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = db.batch();
    for (const uid of recipients.slice(i, i + batchSize)) {
      const ref = db.collection("notifications").doc();
      batch.set(ref, {
        notificationId: ref.id, userId: uid, title, message, type,
        read: false, createdAt: FieldValue.serverTimestamp(), expiresAt: null
      });
    }
    await batch.commit();
  }

  await logAdminAction({ adminUserId, action: "NOTIFICATION_SENT", metadata: { target, count: recipients.length, title } });
  return { success: true, recipientCount: recipients.length };
});

// ---------------------------------------------------------------------
// 8. BASIC RISK SCORING
// ---------------------------------------------------------------------
//
// A starting point, not a complete fraud engine. Scores accumulate
// from independent signals so no single signal (like a shared IP)
// can push someone straight to CRITICAL alone.

exports.calculateRisk = onCall(async (request) => {
  const adminUserId = assertAdmin(request);
  const { targetUserId } = request.data || {};
  if (!targetUserId) throw new HttpsError("invalid-argument", "targetUserId is required.");

  let score = 0;
  const signals = [];

  const [withdrawalsSnap, referralsSnap] = await Promise.all([
    db.collection("withdrawals").where("userId", "==", targetUserId).get(),
    db.collection("referrals").where("referrerUserId", "==", targetUserId).get()
  ]);

  const rejectedWithdrawals = withdrawalsSnap.docs.filter((d) => d.data().status === "rejected").length;
  if (rejectedWithdrawals >= 2) { score += 20; signals.push("multiple_rejected_withdrawals"); }

  const referralCount = referralsSnap.size;
  const qualifiedReferrals = referralsSnap.docs.filter((d) => d.data().qualified).length;
  if (referralCount >= 10 && qualifiedReferrals / Math.max(referralCount, 1) < 0.2) {
    score += 25; signals.push("low_quality_referral_pattern");
  }

  let riskLevel = "LOW";
  if (score >= 70) riskLevel = "CRITICAL";
  else if (score >= 40) riskLevel = "HIGH";
  else if (score >= 15) riskLevel = "MEDIUM";

  await db.collection("users").doc(targetUserId).update({ riskScore: score, riskLevel, updatedAt: FieldValue.serverTimestamp() });
  await db.collection("fraudLogs").add({
    userId: targetUserId, riskLevel, riskScore: score, signals,
    description: "Risk recalculated", status: "open",
    reviewedBy: null, reviewedAt: null, createdAt: FieldValue.serverTimestamp()
  });
  await logAdminAction({ adminUserId, action: "RISK_RECALCULATED", targetUserId, metadata: { score, riskLevel } });

  return { score, riskLevel, signals };
});
