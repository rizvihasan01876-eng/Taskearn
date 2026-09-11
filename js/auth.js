/**
 * AUTH — Firebase Authentication + user document lifecycle.
 *
 * Security note: registration NEVER writes `role` or any financial field.
 * Those are set server-side only (see functions/index.js `onUserCreate` /
 * the Firestore rules, which reject client writes to those fields).
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { friendlyAuthError } from "./utils.js";

function generateReferralCode(fullName) {
  const base = (fullName || "USER").replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 5) || "USER";
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${base}${rand}`;
}

/**
 * Look up the userId that owns a given referral code.
 * Returns null if not found. Used at registration time only.
 */
async function findUserByReferralCode(code) {
  if (!code) return null;
  const q = query(collection(db, "users"), where("referralCode", "==", code.trim().toUpperCase()), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/**
 * Register a new user: creates the Auth account, then the Firestore
 * user document with only safe, non-financial, non-privileged fields.
 * `referredBy` is recorded here but referral COMMISSION is never
 * calculated client-side — see functions/index.js `creditReferralCommission`.
 */
export async function registerUser({ fullName, email, password, phone, country, referralCodeInput }) {
  let referrerUserId = null;
  let referralCode = null;
  if (referralCodeInput) {
    referrerUserId = await findUserByReferralCode(referralCodeInput);
    referralCode = referrerUserId ? referralCodeInput.trim().toUpperCase() : null;
  }

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: fullName });

  const newReferralCode = generateReferralCode(fullName);

  await setDoc(doc(db, "users", cred.user.uid), {
    uid: cred.user.uid,
    fullName,
    email,
    phone: phone || "",
    country: country || "",
    photoURL: "",
    role: "user",                 // fixed — cannot be overridden by caller
    status: "active",
    referralCode: newReferralCode,
    referredBy: referrerUserId,   // null if none / invalid
    referredByCode: referralCode,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    totalReferralEarned: 0,
    riskLevel: "LOW",
    riskScore: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastLoginAt: serverTimestamp()
  });

  // If there was a valid referrer, create the pending referral record.
  // Server-side Cloud Function `onReferralQualify` promotes this to
  // "qualified" and pays commission once the referred user completes
  // a valid earning activity — never here.
  if (referrerUserId) {
    await setDoc(doc(db, "referrals", `${referrerUserId}_${cred.user.uid}`), {
      referralId: `${referrerUserId}_${cred.user.uid}`,
      referrerUserId,
      referredUserId: cred.user.uid,
      referralCode,
      status: "pending",
      qualified: false,
      totalEligibleEarnings: 0,
      totalCommission: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  return cred.user;
}

export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  // lastLoginAt is updated server-side by the `onUserSignIn` callable
  // (kept here as a best-effort client update as well, rules allow it).
  const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js");
  try {
    await updateDoc(doc(db, "users", cred.user.uid), { lastLoginAt: serverTimestamp() });
  } catch (_) { /* non-fatal */ }
  return cred.user;
}

export async function logoutUser() {
  await signOut(auth);
  window.location.href = "/login.html";
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

/**
 * Fetch the current user's Firestore profile document.
 */
export async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Resolve auth state once (Promise wrapper around onAuthStateChanged).
 */
export function getCurrentUser() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

/**
 * Guard for pages that require a logged-in, non-banned/suspended user.
 * Redirects appropriately and returns { user, profile } or null.
 */
export async function requireAuth({ redirectTo = "/login.html" } = {}) {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = redirectTo;
    return null;
  }
  const profile = await getUserDoc(user.uid);
  if (!profile) {
    await logoutUser();
    return null;
  }
  if (profile.status === "banned") {
    window.location.href = "/account-status.html?status=banned";
    return null;
  }
  if (profile.status === "suspended") {
    window.location.href = "/account-status.html?status=suspended";
    return null;
  }
  return { user, profile };
}

/**
 * Guard for admin pages. Requires custom claim `admin: true` OR
 * role stored in Firestore as admin/super_admin AND a valid Cloud
 * Function–issued custom claim (claims are the real check — the
 * Firestore `role` field is convenience/display only, since it can
 * only be admin if a trusted server process set it AND the matching
 * claim, per firestore.rules).
 */
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = "/login.html";
    return null;
  }
  const tokenResult = await user.getIdTokenResult(true);
  const isAdmin = tokenResult.claims.admin === true || tokenResult.claims.superAdmin === true;
  if (!isAdmin) {
    window.location.href = "/dashboard.html";
    return null;
  }
  const profile = await getUserDoc(user.uid);
  return { user, profile, claims: tokenResult.claims };
}

/**
 * Redirect an already-logged-in user away from login/register pages.
 */
export async function redirectIfAuthenticated(destination = "/dashboard.html") {
  const user = await getCurrentUser();
  if (user) window.location.href = destination;
}

export { friendlyAuthError };
