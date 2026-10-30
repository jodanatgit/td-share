import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// "Johan kom fram till PT-PASS": whenever someone's latest position changes (browser or OwnTracks), check it
// against the event's places and routes and record arrivals in events/{id}/arrivals for the app's feed.
//
// To not report again while someone lingers at the edge, a target counts as left only further away than it
// counts as reached, and the same arrival isn't reported twice within ARRIVAL_COOLDOWN_MS. What each person is at
// right now is kept in events/{id}/presence/{userName} (server only).

const PLACE_ENTER_M = 40;
const PLACE_LEAVE_M = 100;
const ROUTE_ENTER_M = 30;
const ROUTE_LEAVE_M = 80;
const MAX_ACCURACY_M = 75; // rougher fixes could report arrivals that didn't happen
const ARRIVAL_COOLDOWN_MS = 10 * 60 * 1000;
const TARGETS_CACHE_MS = 20_000;

// Metres on a local flat projection: plenty exact over the few kilometres of an event
const project = (lat0) => {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lng) => [lng * kx, lat * 110540];
};

const segmentDistance = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Shortest distance from a position to a route (flat lat/lng list split into segments at `breaks`)
const routeDistance = (route, lat, lng) => {
  const xy = project(lat);
  const p = xy(lat, lng);
  const starts = route.breaks?.length ? route.breaks : [0];
  const n = route.coords.length / 2;
  let best = Infinity;
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : n;
    for (let k = start; k < end - 1; k++) {
      const a = xy(route.coords[k * 2], route.coords[k * 2 + 1]);
      const b = xy(route.coords[k * 2 + 2], route.coords[k * 2 + 3]);
      best = Math.min(best, segmentDistance(p, a, b));
    }
  });
  return best;
};

const placeDistance = (place, lat, lng) => {
  const xy = project(lat);
  const [px, py] = xy(lat, lng);
  const [qx, qy] = xy(place.lat, place.lng);
  return Math.hypot(px - qx, py - qy);
};

// The event with its places and routes, briefly cached per event (positions arrive every few seconds)
const cache = new Map();
async function loadTargets(db, eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.loadedAt < TARGETS_CACHE_MS) return hit;
  const base = db.doc(`events/${eventId}`);
  const [event, places, routes] = await Promise.all([base.get(), base.collection('places').get(), base.collection('routes').get()]);
  const targets = {
    loadedAt: Date.now(),
    event: event.exists ? event.data() : null,
    places: places.docs.map((d) => ({ id: d.id, ...d.data() })),
    routes: routes.docs.map((d) => ({ id: d.id, ...d.data() }))
  };
  cache.set(eventId, targets);
  return targets;
}

export const onMemberWritten = onDocumentWritten(
  { document: 'events/{eventId}/members/{userName}', region: 'europe-west1', maxInstances: 10 },
  async (e) => {
    const pos = e.data?.after?.exists ? e.data.after.data() : null;
    if (!pos || !(pos.accuracy <= MAX_ACCURACY_M)) return;
    const { eventId, userName } = e.params;
    const db = getFirestore();
    const { event, places, routes } = await loadTargets(db, eventId);
    if (!event || event.endsAt.toMillis() <= Date.now() || (!places.length && !routes.length)) return;

    const presenceRef = db.doc(`events/${eventId}/presence/${userName}`);
    await db.runTransaction(async (tx) => {
      const presence = (await tx.get(presenceRef)).data() || {};
      const wasAt = new Set(presence.at || []);
      const lastArrival = presence.lastArrival || {};
      const nowAt = [];
      const arrived = [];

      const check = (kind, target, d, enter, leave) => {
        const key = `${kind}:${target.id}`;
        if (wasAt.has(key) ? d <= leave : d <= enter) {
          nowAt.push(key);
          if (!wasAt.has(key) && !(Date.now() - (lastArrival[key] || 0) < ARRIVAL_COOLDOWN_MS)) {
            arrived.push({ key, kind, target });
          }
        }
      };
      for (const p of places) check('place', p, placeDistance(p, pos.lat, pos.lng), PLACE_ENTER_M, PLACE_LEAVE_M);
      for (const r of routes) check('route', r, routeDistance(r, pos.lat, pos.lng), ROUTE_ENTER_M, ROUTE_LEAVE_M);

      const at = pos.updatedAt || Timestamp.now();
      for (const { key, kind, target } of arrived) {
        lastArrival[key] = at.toMillis();
        tx.create(db.collection(`events/${eventId}/arrivals`).doc(), {
          userName,
          kind,
          targetId: target.id,
          targetName: kind === 'place' ? target.title : target.name,
          at,
          expireAt: event.endsAt
        });
      }
      tx.set(presenceRef, { at: nowAt, lastArrival, expireAt: event.endsAt });
    });
  }
);
