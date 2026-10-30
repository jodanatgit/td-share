import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// /api on Firebase Hosting (firebase.json):
//   POST /api/owntracks/token  signed-in user (Firebase ID token) -> a new personal OwnTracks password
//   POST /api/owntracks        the OwnTracks app (HTTP mode, basic auth user name + that password) -> position
// Arrivals at places and routes: arrivals.js (Firestore trigger on positions)
//
// OwnTracks keeps sending in the background with the screen off. A position is only stored while the person has
// opted in to a running event (sharing/{userName}, set from the app); everything else is dropped.

initializeApp();
const db = getFirestore();

const ALLOWED_EMAIL_DOMAIN = 'totaldigital.se';
// Keep in sync with FULL_NAME_USERS in src/auth.ts
const FULL_NAME_USERS = ['hanna.swedenklef', 'daniel.sedell'];

const POINT_EVERY_MS = 30_000;
const POINT_MOVE_M = 25;
const POINT_MAX_ACCURACY_M = 100;

const nameFromEmail = (email) => {
  const prefix = email.trim().toLowerCase().split('@')[0];
  return FULL_NAME_USERS.includes(prefix) ? prefix : prefix.split('.')[0];
};

const sha256 = (s) => createHash('sha256').update(s).digest();

const distance = (a, b) => {
  const r = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

async function createToken(req, res) {
  const idToken = (req.get('Authorization') || '').replace(/^Bearer /, '');
  let user;
  try {
    user = await getAuth().verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const email = String(user.email || '').toLowerCase();
  if (!user.email_verified || !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const userName = nameFromEmail(email);
  const password = randomBytes(24).toString('base64url');
  // A new password replaces the old one, so a lost phone is cut off by setting up again
  await db.doc(`owntracks_tokens/${userName}`).set({ hash: sha256(password).toString('hex'), createdAt: Timestamp.now() });
  res.json({ username: userName, password });
}

async function checkBasicAuth(req) {
  const m = (req.get('Authorization') || '').match(/^Basic (.+)$/);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 1) return null;
  const userName = decoded.slice(0, i).toLowerCase();
  const password = decoded.slice(i + 1);
  if (!/^[a-z0-9._-]{1,64}$/.test(userName)) return null;
  const snap = await db.doc(`owntracks_tokens/${userName}`).get();
  if (!snap.exists) return null;
  const expected = Buffer.from(snap.data().hash, 'hex');
  return timingSafeEqual(expected, sha256(password)) ? userName : null;
}

async function receiveLocation(req, res) {
  const userName = await checkBasicAuth(req);
  if (!userName) return res.status(401).json([]);

  // OwnTracks expects a JSON array back (other people's positions could be returned here)
  const msg = req.body;
  if (!msg || msg._type !== 'location') return res.json([]);
  const lat = Number(msg.lat);
  const lng = Number(msg.lon);
  const accuracy = Math.max(0, Math.round(Number(msg.acc) || 0));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.json([]);

  const sharingRef = db.doc(`sharing/${userName}`);
  const sharing = await sharingRef.get();
  if (!sharing.exists) return res.json([]);
  const { eventId, since, lastPoint } = sharing.data();
  const eventSnap = await db.doc(`events/${eventId}`).get();
  if (!eventSnap.exists) return res.json([]);
  const event = eventSnap.data();

  // OwnTracks queues positions while offline and sends them later with their own time (tst, seconds)
  const now = Date.now();
  const at = Math.min(Number(msg.tst) * 1000 || now, now);
  if (event.endsAt.toMillis() <= now || at < (since?.toMillis?.() ?? now)) return res.json([]);

  const base = `events/${eventId}`;
  const memberRef = db.doc(`${base}/members/${userName}`);
  const fix = { lat, lng, accuracy };
  await db.runTransaction(async (tx) => {
    const member = await tx.get(memberRef);
    const prev = member.exists ? member.data().updatedAt?.toMillis?.() ?? 0 : 0;
    // A late, queued position never replaces a newer one on the map, but still becomes part of the track
    if (at >= prev) {
      tx.set(memberRef, { userName, ...fix, updatedAt: Timestamp.fromMillis(at), expireAt: event.endsAt });
    }
    const due = !lastPoint || Math.abs(at - lastPoint.at) >= POINT_EVERY_MS || distance(lastPoint, fix) >= POINT_MOVE_M;
    if (accuracy <= POINT_MAX_ACCURACY_M && due) {
      tx.create(db.collection(`${base}/points`).doc(), {
        userName,
        ...fix,
        at: Timestamp.fromMillis(at),
        expireAt: event.endsAt
      });
      tx.update(sharingRef, { lastPoint: { lat, lng, at } });
    }
  });
  res.json([]);
}

export const api = onRequest({ region: 'europe-west1', maxInstances: 5 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).end();
    if (req.path === '/api/owntracks/token') return await createToken(req, res);
    if (req.path === '/api/owntracks') return await receiveLocation(req, res);
    res.status(404).end();
  } catch (err) {
    logger.error('api failed', { path: req.path, err: String(err) });
    res.status(500).json([]);
  }
});

export { onMemberWritten } from './arrivals.js';
