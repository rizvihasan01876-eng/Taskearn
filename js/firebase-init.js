/**
 * FIREBASE INITIALIZATION
 * Central place every other module imports Firebase services from.
 * Uses the Firebase v10 modular SDK loaded from the official CDN.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

import { firebaseConfig, FUNCTIONS_REGION } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("Auth persistence could not be set:", err.code);
});

// Firestore with local cache for snappier repeat loads / minor offline resilience.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) })
});

export const functions = getFunctions(app, FUNCTIONS_REGION);

// Toggle true only during local development with the Firebase Emulator Suite.
const USE_EMULATORS = false;
if (USE_EMULATORS && location.hostname === "localhost") {
  const { connectAuthEmulator } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js");
  const { connectFirestoreEmulator } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js");
  const { connectFunctionsEmulator } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js");
  connectAuthEmulator(auth, "http://localhost:9099");
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
}
