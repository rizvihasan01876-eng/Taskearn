# TaskEarn — Architecture & Setup

> **Status of this build:** Part 1 of a multi-part delivery (this codebase is
> too large for one response — see "What's built so far / what's next" at
> the bottom). Nothing here is a mockup: auth, Firestore schema, security
> rules, and the financial Cloud Functions are real and wired together.

## Architecture in one paragraph

The frontend (vanilla JS, ES modules, no framework) never touches money
directly. It reads Firestore (subject to `firestore.rules`) and calls
Cloud Functions for anything financial. Cloud Functions run with the
Admin SDK, so **they** are the actual security boundary — they validate
everything themselves (auth state, account status, amounts, idempotency)
before writing. Provider postbacks land on an HTTPS Cloud Function,
never in the browser, so a user's own client can never fabricate a
"task completed" event.

```
Browser (ES modules)              Cloud Functions (Admin SDK)           Firestore
──────────────────────            ───────────────────────────           ─────────
auth.js  ──signIn/register──────▶ (Auth SDK directly)
dashboard.js ──onSnapshot────────────────────────────────────────────▶ users/{uid} (read-only for owner)
withdraw.js ──createWithdrawal()▶ createWithdrawal (validates, writes)▶ withdrawals/, transactions/
                                   processProviderPostback (HTTPS)  ──▶ campaignCompletions/, transactions/, users/
admin/*.js ──processWithdrawal()▶ processWithdrawal (admin claim)   ──▶ withdrawals/, transactions/
```

## Firestore schema (collections built so far)

### `users/{uid}`
| field | type | who writes it |
|---|---|---|
| uid, fullName, email, phone, country, photoURL | string | owner (create + limited update) |
| role | `user` \| `admin` \| `super_admin` | **Cloud Functions only** (`setUserRole`) |
| status | `active` \| `warning` \| `suspended` \| `banned` | admin panel → Cloud Functions |
| referralCode | string | generated at registration |
| referredBy | uid or null | set once, at registration |
| balance, totalEarned, totalWithdrawn, totalReferralEarned | number | **Cloud Functions only**, via ledger transactions |
| riskLevel, riskScore | string/number | `calculateRisk` function |
| createdAt, updatedAt, lastLoginAt | timestamp | mixed |

Index requirement: none beyond default (single-field lookups only).

### `campaigns/{campaignId}` — admin-managed, publicly readable while `active`
Fields exactly as specified in the brief: `title, provider, category,
description, instructions, reward, currency, status, priority,
startDate, endDate, allowedCountries, trackingUrl, integrationType,
trackingId, imageUrl, terms, dailyLimit, userLimit, createdAt,
updatedAt`. Composite indexes for `(status, priority, createdAt)` and
`(status, category, priority)` are in `firestore.indexes.json`.

### `campaignCompletions/{provider_providerConversionId}`
Document ID is deterministic (`${provider}_${providerConversionId}`) —
this is what makes duplicate postbacks impossible to double-credit; see
`functions/index.js → creditConversion`. Fields: `provider,
providerConversionId, userId, campaignId, reward, status
(pending|approved|rejected|reversed), createdAt, processedAt`.

### `transactions/{transactionId}` — append-only ledger
`transactionId, userId, type (campaign_reward|referral_reward|bonus|
withdrawal|withdrawal_reversal|admin_adjustment), amount,
balanceBefore, balanceAfter, referenceId, description, status,
createdAt, createdBy`. Never updated or deleted — corrections are new
rows (e.g. `withdrawal_reversal`), so the ledger is always auditable.

### `withdrawals/{withdrawalId}`
`userId, amount, method, accountNumber, accountName, notes, status
(pending|processing|approved|paid|rejected|cancelled), riskFlag,
createdAt, updatedAt, rejectionReason?`.

### `referrals/{referrerUid_referredUid}`
`referrerUserId, referredUserId, referralCode, status
(pending|active|qualified|blocked), qualified, totalEligibleEarnings,
totalCommission, createdAt, updatedAt`.

### `settings/general` (singleton doc)
`siteName, siteTagline, currency, minimumWithdrawal,
maximumWithdrawal, withdrawalEnabled, registrationEnabled,
referralCommissionPercent (default 10), supportEmail,
maintenanceMode, …`. Publicly readable, only super-admin writable.

### Collections referenced but not yet built out in this part
`notifications`, `announcements`, `fraudLogs`, `warnings`, `adminLogs`,
`adPlacements` — the rules, indexes, and the Cloud Functions that write
them (`sendNotification`, `calculateRisk`, `logAdminAction`) already
exist; the admin UI to manage them ships in the next part.

## Who can read/write what (enforced in `firebase/firestore.rules`)

- A user can read/update only their **own** profile, and only the safe
  fields (`fullName, phone, country, photoURL`) — never
  `balance/role/riskScore/status`.
- `transactions`, `withdrawals`, `campaignCompletions` are **read-only**
  from the client, always. All writes go through Cloud Functions.
- `campaigns` are publicly readable only while `status == 'active'`.
- Everything admin-only checks a **custom auth claim**
  (`admin`/`superAdmin`), not a Firestore field — so even if someone
  could edit their own `users/{uid}.role` (they can't, per the rule
  above), it wouldn't grant real admin access.

## Where you'll plug in provider details later

| Placeholder | File | What to replace it with |
|---|---|---|
| `firebaseConfig` object | `js/firebase-config.js` | Firebase Console → Project Settings → your web app config |
| `CPX_SECURE_HASH_SECRET` | Functions secret (not a file) | `firebase functions:secrets:set CPX_SECURE_HASH_SECRET` |
| `CPAGRIP_POSTBACK_SECRET` | Functions secret (not a file) | `firebase functions:secrets:set CPAGRIP_POSTBACK_SECRET` |
| CPX/CPAGrip field names in `PROVIDER_VERIFIERS` | `functions/index.js` | Exact query-param names from your provider's postback URL builder — send me a screenshot of that screen and I'll map it precisely |
| `YOUR_ADSTERRA_AD_CODE` | `admin/ads.html` (next part) | Adsterra ad unit code, pasted through the admin Ads panel — never incentivized |

I did not invent any campaign IDs, publisher IDs, or postback secrets —
those fields are wired up as configuration, waiting for your real values.

## Setup

1. **Create a Firebase project** at console.firebase.google.com.
2. **Enable Authentication** → Sign-in method → Email/Password.
3. **Create a Firestore database** (production mode, pick your region).
4. **Register a Web app** in Project Settings → copy the config into
   `js/firebase-config.js`.
5. Install the CLI and log in: `npm i -g firebase-tools && firebase login`.
6. `firebase init` in this folder (select Firestore + Functions, point
   at your project) — or just set `.firebaserc` manually.
7. **Deploy rules:** `firebase deploy --only firestore:rules`
8. **Deploy indexes:** `firebase deploy --only firestore:indexes`
9. **Set function secrets**, then **deploy functions**:
   ```
   firebase functions:secrets:set CPX_SECURE_HASH_SECRET
   firebase functions:secrets:set CPAGRIP_POSTBACK_SECRET
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
10. **Create the first admin** (never through public registration):
    ```js
    // Run once, e.g. from a local trusted Node script using firebase-admin
    // with your service account key (never in the frontend):
    const admin = require("firebase-admin");
    admin.initializeApp();
    const uid = "PASTE_THE_USER_UID_HERE"; // register normally first, then promote
    await admin.auth().setCustomUserClaims(uid, { admin: true, superAdmin: true });
    await admin.firestore().collection("users").doc(uid).update({ role: "super_admin" });
    ```
    (Once you have one super admin, they can promote others through the
    admin panel's `setUserRole` callable instead.)
11. **Configure provider postback URLs** in CPX Research / CPAGrip's
    dashboards to point at:
    `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/processProviderPostback?provider=cpx&...`
12. **Deploy the static site** (Firebase Hosting is simplest:
    `firebase init hosting`, set public dir to `.`, then
    `firebase deploy --only hosting`).

## Security checklist

- [x] Frontend never writes `balance`, `totalEarned`, `role`, or any
      ledger field — enforced by both the rules and by simply not
      exposing that write path in client code.
- [x] Every financial write happens inside a `runTransaction` with a
      read-then-write of the user's current balance (no lost updates).
- [x] Conversions are keyed by `provider_providerConversionId` so a
      duplicate postback is a no-op, not a double credit.
- [x] Provider secrets live in Cloud Functions Secret Manager, never in
      any file that ships to the browser.
- [x] Admin checks use custom auth claims, checked both in Firestore
      rules and again inside every admin callable function.
- [x] Withdrawal rejection/cancellation restores balance via a new
      ledger row, never by editing the original transaction.
- [ ] Add App Check (recommended, not yet wired) to reduce abuse of
      callable functions from outside your own app.
- [ ] Add rate limiting / Cloud Armor in front of
      `processProviderPostback` once you have real provider IPs to
      allow-list.

## Testing checklist (for this part)

- [ ] Register → Firestore `users/{uid}` created with `balance: 0,
      role: "user"` and, if a `?ref=CODE` was present, a `referrals/`
      doc with `status: "pending"`.
- [ ] Attempt (via browser devtools) to write `users/{uid}.balance`
      directly → rejected by rules.
- [ ] Log in with wrong password → friendly error, no account
      enumeration.
- [ ] Visit `/dashboard.html` while logged out → redirected to
      `/login.html`.
- [ ] Manually flag a test user `status: "banned"` in Firestore → they
      're redirected to `/account-status.html` on next load.
- [ ] Call `processProviderPostback` twice with the same
      `providerConversionId` → second call returns `OK_DUPLICATE` and
      balance only changes once.
- [ ] Toggle dark mode → persists across reload.

## What's built so far / what's next

**Done (this part):** project skeleton, design system (`css/global.css`
+ tokens), Firebase init, full auth flow (register/login/reset/guards),
Firestore rules + indexes, the complete financial Cloud Functions layer
(postback verification, reward crediting, 10% referral commission,
withdrawals + reversal, admin balance adjustment, notifications,
basic risk scoring, admin role management), homepage, and a live
dashboard.

**Next parts:** `earn.html`/`campaign.html` (campaign browsing + start
flow), `wallet.html`, `withdraw.html`, `referrals.html`,
`transactions.html`, `notifications.html`, `profile.html`, `help.html`,
`terms.html`/`privacy.html`/`contact.html`, the full admin panel (13
pages: users, campaigns, withdrawals, transactions, referrals, fraud,
ads, settings, admin logs, announcements), and `css/admin.css`.

Say the word and I'll continue straight into the Earn/Wallet/Withdraw/
Referrals pages, then the admin panel.
