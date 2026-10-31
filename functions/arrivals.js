import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// "Johan kom fram till PT-PASS": whenever someone's latest position changes (browser or OwnTracks), check it
// against the event's places and routes and record arrivals in events/{id}/arrivals for the app's feed.
//
// To not report again while someone lingers at the edge, a target counts as left only further away than it
// counts as reached, and the same arrival isn't reported twice within ARRIVAL_COOLDOWN_MS. What each person is at
// right now is kept in events/{id}/presence/{userName} (server only).
//
// Along a route, the distance covered is measured along the route itself (not the GPS zigzag), every km is
// reported with time and pace ("Johan har klarat 3 km av Halvan"), and reaching the end after most of the route
// reports the whole time. That progress is kept in presence too.

const PLACE_ENTER_M = 40;
const PLACE_LEAVE_M = 100;
const ROUTE_ENTER_M = 30;
const ROUTE_LEAVE_M = 80;
const MAX_ACCURACY_M = 75; // rougher fixes could report arrivals that didn't happen
const ARRIVAL_COOLDOWN_MS = 10 * 60 * 1000;
const TARGETS_CACHE_MS = 20_000;

const PROGRESS_EVERY_M = 1000;
const PROGRESS_GAP_MS = 10 * 60 * 1000; // away from a route longer than this, and progress on it starts over
const PROGRESS_TURN_M = 50; // movement along the route that counts, so GPS jitter back and forth doesn't
const FINISH_SHARE = 0.9; // of the route covered, and
const FINISH_END_M = 60; // this close to its end, counts as done

// Metres on a local flat projection: plenty exact over the few kilometres of an event
const project = (lat0) => {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lng) => [lng * kx, lat * 110540];
};

const closestOnSegment = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
};

// A route (flat lat/lng list split into segments at `breaks`) as projected segments with their distance from the start
const routeGeometry = (route) => {
  const n = Math.floor((route.coords?.length || 0) / 2);
  const xy = project(route.coords?.[0] || 0);
  const pts = [];
  for (let k = 0; k < n; k++) pts.push(xy(route.coords[k * 2], route.coords[k * 2 + 1]));
  const starts = route.breaks?.length ? route.breaks : [0];
  const segs = [];
  let length = 0;
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : n;
    for (let k = start; k < end - 1; k++) {
      const len = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      segs.push({ a: pts[k], b: pts[k + 1], len, from: length });
      length += len;
    }
  });
  return { xy, segs, length };
};

// How far a position is from a route, and how far along the route the closest point is. Where the route passes the
// same spot twice (out and back, a loop), the point closest to where the person was before (`prevAlong`) wins.
const locate = (geo, lat, lng, prevAlong) => {
  if (!geo.segs.length) return { d: Infinity, along: 0 };
  const p = geo.xy(lat, lng);
  const hits = geo.segs.map((s) => {
    const { d, t } = closestOnSegment(p, s.a, s.b);
    return { d, along: s.from + t * s.len };
  });
  const d = hits.reduce((m, h) => Math.min(m, h.d), Infinity);
  const near = hits.filter((h) => h.d <= d + ROUTE_ENTER_M);
  const pick =
    prevAlong === undefined
      ? hits.find((h) => h.d === d)
      : near.reduce((a, b) => (Math.abs(b.along - prevAlong) < Math.abs(a.along - prevAlong) ? b : a));
  return { d, along: pick.along };
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
    routes: routes.docs.map((d) => ({ id: d.id, name: d.data().name, geo: routeGeometry(d.data()) }))
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
      const progress = presence.progress || {};
      const at = pos.updatedAt || Timestamp.now();
      const atMs = at.toMillis();
      const nowAt = [];
      const reports = [];

      const check = (kind, target, d, enter, leave) => {
        const key = `${kind}:${target.id}`;
        if (!(wasAt.has(key) ? d <= leave : d <= enter)) return false;
        nowAt.push(key);
        if (!wasAt.has(key) && !(atMs - (lastArrival[key] || 0) < ARRIVAL_COOLDOWN_MS)) {
          lastArrival[key] = atMs;
          reports.push({ kind, targetId: target.id, targetName: kind === 'place' ? target.title : target.name });
        }
        return true;
      };

      // Distance covered along the route: only movement in one direction counts, a turn needs PROGRESS_TURN_M, and
      // a jump along the route much longer than the person moved (a loop's end meeting its start) isn't counted
      const advance = (route, along, s) => {
        const geo = route.geo;
        if (!s) {
          progress[route.id] = { startAt: atMs, lastAt: atMs, lat: pos.lat, lng: pos.lng, mark: along, dir: 0, covered: 0, km: 0, kmAt: atMs, kmCovered: 0 };
          return;
        }
        if (atMs <= s.lastAt) return; // an older position handled late
        const [x0, y0] = geo.xy(s.lat, s.lng);
        const [x1, y1] = geo.xy(pos.lat, pos.lng);
        const moved = Math.hypot(x1 - x0, y1 - y0);
        const delta = along - s.mark;
        if (Math.abs(delta) > 2 * moved + 150) {
          s.mark = along;
        } else if (s.dir ? delta * s.dir > 0 || -delta * s.dir >= PROGRESS_TURN_M : Math.abs(delta) >= PROGRESS_TURN_M) {
          s.dir = Math.sign(delta);
          s.covered += Math.abs(delta);
          s.mark = along;
        }
        Object.assign(s, { lastAt: atMs, lat: pos.lat, lng: pos.lng });

        const base = { kind: 'route', targetId: route.id, targetName: route.name, coveredM: Math.round(s.covered), elapsedS: Math.round((atMs - s.startAt) / 1000) };
        const left = s.dir > 0 ? geo.length - along : along;
        if (s.dir && s.covered >= FINISH_SHARE * geo.length && left <= FINISH_END_M) {
          reports.push({ ...base, kind: 'finish', lengthM: Math.round(geo.length) });
          delete progress[route.id];
          return;
        }
        const km = Math.floor(s.covered / PROGRESS_EVERY_M);
        if (km > s.km) {
          reports.push({
            ...base,
            kind: 'progress',
            km,
            splitM: Math.round(s.covered - s.kmCovered),
            splitS: Math.round((atMs - s.kmAt) / 1000),
            remainingM: s.dir ? Math.round(Math.max(0, left)) : null
          });
          Object.assign(s, { km, kmAt: atMs, kmCovered: s.covered });
        }
      };

      for (const p of places) check('place', p, placeDistance(p, pos.lat, pos.lng), PLACE_ENTER_M, PLACE_LEAVE_M);
      for (const r of routes) {
        const s = progress[r.id] && atMs - progress[r.id].lastAt <= PROGRESS_GAP_MS ? progress[r.id] : null;
        const { d, along } = locate(r.geo, pos.lat, pos.lng, s?.mark);
        if (check('route', r, d, ROUTE_ENTER_M, ROUTE_LEAVE_M)) advance(r, along, s);
      }
      for (const [id, s] of Object.entries(progress)) if (atMs - s.lastAt > PROGRESS_GAP_MS) delete progress[id];

      for (const r of reports) {
        tx.create(db.collection(`events/${eventId}/arrivals`).doc(), { userName, ...r, at, expireAt: event.endsAt });
      }
      tx.set(presenceRef, { at: nowAt, lastArrival, progress, expireAt: event.endsAt });
    });
  }
);
