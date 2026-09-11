/**
 * FIREBASE CONFIG — PLACEHOLDER
 * ------------------------------------------------------------------
 * Get these values from: Firebase Console → Project Settings → General
 * → "Your apps" → Web app → SDK setup and configuration → Config
 *
 * This is a PUBLIC client config. It is safe to ship in frontend code —
 * it identifies your project, it does not grant privileged access.
 * The real security boundary is Firestore Security Rules + Cloud Functions,
 * not secrecy of this object.
 *
 * DO NOT put service account keys, provider secrets, or postback secrets
 * here. Those belong in Cloud Functions environment config only.
 * ------------------------------------------------------------------
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBSeE836nxNQt5hZ_SNtMUq4pVaQ_MUL6s",
  authDomain: "taskearn-a9e98.firebaseapp.com",
  projectId: "taskearn-a9e98",
  storageBucket: "taskearn-a9e98.firebasestorage.app",
  messagingSenderId: "520635380143",
  appId: "1:520635380143:web:37476e3d8c624af66f7f5a",
  measurementId: "G-ZFHYP5W1M7"
};

// Region your Cloud Functions are deployed to (must match functions/index.js)
export const FUNCTIONS_REGION = "us-central1";

// Public business settings that are safe to know before Firestore loads.
// The authoritative copy lives in Firestore `settings/general` — this is
// only a fallback used before that document has loaded.
export const APP_DEFAULTS = {
  siteName: "TaskEarn",
  siteTagline: "Complete Tasks. Earn Rewards.",
  currency: "BDT",
  currencySymbol: "৳"
};
