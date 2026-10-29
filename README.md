# TD Share

See where your Total Digital colleagues are during a workshop, conference or other event. Each person opts in
per event and shares their phone's GPS position; everyone in the event sees the others on a map, with tracks.

- **Sign-in:** email link, verified `@totaldigital.se` addresses only (same as Morgonkartan, `src/auth.ts`).
- **Events:** anyone can create one, running from now for 2 h up to 3 days. The creator can end it early,
  which deletes all positions and tracks at once. Events can't be extended.
- **Privacy:** sharing is off until you tap *Dela min position*, stops when you tap *Sluta dela* or the event
  ends, and positions/tracks can't be read once the event has ended (`firestore.rules`). Firestore TTL on
  `expireAt` deletes events, positions and tracks after the event's end (usually within 24 h).
- **Screen off:** browsers pause GPS when the screen is off. For background sharing, colleagues install the free
  OwnTracks app once (iPhone/Android) via *Ställ in OwnTracks* (`#/owntracks`), which creates a personal password
  and opens the settings in OwnTracks. OwnTracks then posts to `/api/owntracks` (`functions/index.js`), which only
  stores a position while that person has opted in to a running event (`sharing/{userName}`); otherwise it is dropped.
  The browser also shares while the page is open (with a screen wake lock).

## Data (Firestore)

| Path | Contents |
| --- | --- |
| `events/{id}` | `name`, `createdBy`, `createdAt`, `endsAt`, `expireAt` |
| `events/{id}/members/{userName}` | latest position: `lat`, `lng`, `accuracy`, `updatedAt` |
| `events/{id}/points/{auto}` | track: `userName`, `lat`, `lng`, `accuracy`, `at` |
| `sharing/{userName}` | opt-in: `eventId`, `since` (one event at a time); `lastPoint` is server-owned |
| `owntracks_tokens/{userName}` | SHA-256 of the person's OwnTracks password, server only |

## Setup

Firebase project: `td-share`, on the Blaze plan (Cloud Functions). Function `api` runs in europe-west1;
`FULL_NAME_USERS` in `functions/index.js` must match `src/auth.ts`. `.env` holds the web app config (not secret, but not committed):

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=td-share.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=td-share
VITE_FIREBASE_STORAGE_BUCKET=td-share.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Get the values with `firebase apps:sdkconfig WEB --project td-share`.

```
npm install
(cd functions && npm install)
npm run dev
npm run build
firebase deploy --only hosting,firestore,functions
```

`firebase deploy --only firestore` deploys the rules and the TTL policies in `firestore.indexes.json`.
