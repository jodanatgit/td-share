import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { TdEvent } from '../types';

// Sharing has two parts:
//   sharing/{userName} = { eventId }   my opt-in, one event at a time. OwnTracks positions (functions/index.js) are
//                                      only stored while this points at a running event, so it works with the screen off.
//   this device's GPS                  while the page is open, the browser also sends positions (opted in per device):
//     events/{id}/members/{userName}   latest position, at most every 10 s (or right away after moving 20 m)
//     events/{id}/points               the track, at most every 30 s (or after moving 25 m), only fairly exact fixes

const MEMBER_EVERY_MS = 10_000;
const MEMBER_MOVE_M = 20;
const POINT_EVERY_MS = 30_000;
const POINT_MOVE_M = 25;
const POINT_MAX_ACCURACY_M = 100;

// 'remote': opted in, but positions come from OwnTracks or another device, not this browser
export type SharingStatus = 'off' | 'remote' | 'starting' | 'on' | 'denied' | 'unavailable' | 'error';

const storageKey = (eventId: string) => `td-share:gps:${eventId}`;

const distance = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

interface Sent {
  at: number;
  lat: number;
  lng: number;
}

export function useLocationSharing(event: TdEvent | null, userName: string) {
  const eventId = event?.id ?? null;
  const [optedInto, setOptedInto] = useState<string | null | undefined>(undefined);
  const [deviceGps, setDeviceGps] = useState(() => {
    try {
      return !!eventId && localStorage.getItem(storageKey(eventId)) === '1';
    } catch {
      return false;
    }
  });
  const [gpsStatus, setGpsStatus] = useState<SharingStatus>('off');
  const [position, setPosition] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const lastMember = useRef<Sent | null>(null);
  const lastPoint = useRef<Sent | null>(null);

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'sharing', userName),
        (snap) => setOptedInto(snap.exists() ? (snap.data().eventId as string) : null),
        (err) => {
          console.error('sharing listener failed:', err);
          setOptedInto(null);
        }
      ),
    [userName]
  );

  const running = !!event && event.endsAt.toMillis() > Date.now();
  const sharing = !!eventId && optedInto === eventId && running;
  const gpsOn = sharing && deviceGps;

  useEffect(() => {
    if (!gpsOn || !event) {
      setGpsStatus('off');
      setPosition(null);
      return;
    }
    if (!('geolocation' in navigator)) {
      setGpsStatus('unavailable');
      return;
    }
    setGpsStatus('starting');
    const base = `events/${event.id}`;

    const onFix = (pos: GeolocationPosition) => {
      const now = Date.now();
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
      setPosition(fix);
      setGpsStatus('on');

      const m = lastMember.current;
      if (!m || now - m.at >= MEMBER_EVERY_MS || distance(m, fix) >= MEMBER_MOVE_M) {
        lastMember.current = { at: now, ...fix };
        setDoc(doc(db, `${base}/members`, userName), {
          userName,
          ...fix,
          updatedAt: serverTimestamp(),
          expireAt: event.endsAt
        }).catch((err) => {
          console.error('Could not share position:', err);
          setGpsStatus('error');
        });
      }

      const p = lastPoint.current;
      if (fix.accuracy <= POINT_MAX_ACCURACY_M && (!p || now - p.at >= POINT_EVERY_MS || distance(p, fix) >= POINT_MOVE_M)) {
        lastPoint.current = { at: now, ...fix };
        addDoc(collection(db, `${base}/points`), {
          userName,
          ...fix,
          at: serverTimestamp(),
          expireAt: event.endsAt
        }).catch((err) => console.error('Could not save track point:', err));
      }
    };

    const onError = (err: GeolocationPositionError) => {
      console.warn('Geolocation error:', err);
      setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
    };

    const watch = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000
    });

    // Keep the screen (and with it the browser's GPS) on while the page is open; re-acquired when shown again
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        navigator.wakeLock
          .request('screen')
          .then((l) => (lock = l))
          .catch(() => undefined);
      }
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);

    return () => {
      navigator.geolocation.clearWatch(watch);
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => undefined);
      lastMember.current = null;
      lastPoint.current = null;
    };
  }, [gpsOn, event, userName]);

  const rememberDeviceGps = useCallback(
    (on: boolean) => {
      if (!eventId) return;
      try {
        if (on) localStorage.setItem(storageKey(eventId), '1');
        else localStorage.removeItem(storageKey(eventId));
      } catch {
        // private mode: this device's GPS just doesn't resume after a reload
      }
      setDeviceGps(on);
    },
    [eventId]
  );

  // Turning on also uses this device's GPS; turning off removes me from the map (my track stays until the event ends)
  const setSharing = useCallback(
    async (on: boolean) => {
      if (!eventId) return;
      rememberDeviceGps(on);
      try {
        if (on) {
          if (optedInto && optedInto !== eventId) {
            await deleteDoc(doc(db, `events/${optedInto}/members`, userName)).catch(() => undefined);
          }
          await setDoc(doc(db, 'sharing', userName), { eventId, since: serverTimestamp() });
        } else {
          await deleteDoc(doc(db, 'sharing', userName));
          await deleteDoc(doc(db, `events/${eventId}/members`, userName));
        }
      } catch (err) {
        console.error('Could not change sharing:', err);
        setGpsStatus('error');
      }
    },
    [eventId, optedInto, userName, rememberDeviceGps]
  );

  const status: SharingStatus = !sharing ? 'off' : deviceGps ? gpsStatus : 'remote';
  return {
    sharing,
    loaded: optedInto !== undefined,
    deviceGps: gpsOn,
    setDeviceGps: rememberDeviceGps,
    setSharing,
    status,
    position
  };
}
