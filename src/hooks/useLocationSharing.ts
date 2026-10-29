import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { TdEvent } from '../types';

// Shares this phone's GPS position in an event while `sharing` is on:
//   events/{id}/members/{userName}  latest position, at most every 10 s (or right away after moving 20 m)
//   events/{id}/points              the track, at most every 30 s (or after moving 25 m), only fairly exact fixes
// Browsers stop GPS when the screen turns off, so a screen wake lock is held while sharing.

const MEMBER_EVERY_MS = 10_000;
const MEMBER_MOVE_M = 20;
const POINT_EVERY_MS = 30_000;
const POINT_MOVE_M = 25;
const POINT_MAX_ACCURACY_M = 100;

export type SharingStatus = 'off' | 'starting' | 'on' | 'denied' | 'unavailable' | 'error';

const storageKey = (eventId: string) => `td-share:sharing:${eventId}`;

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
  const [sharing, setSharing] = useState(() => {
    try {
      return !!eventId && localStorage.getItem(storageKey(eventId)) === '1';
    } catch {
      return false;
    }
  });
  const [status, setStatus] = useState<SharingStatus>('off');
  const [position, setPosition] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const lastMember = useRef<Sent | null>(null);
  const lastPoint = useRef<Sent | null>(null);

  const running = !!event && event.endsAt.toMillis() > Date.now();

  useEffect(() => {
    if (!sharing || !event || !running) {
      setStatus('off');
      return;
    }
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      return;
    }
    setStatus('starting');
    const base = `events/${event.id}`;

    const onFix = (pos: GeolocationPosition) => {
      const now = Date.now();
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
      setPosition(fix);
      setStatus('on');

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
          setStatus('error');
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
      setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
    };

    const watch = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000
    });

    // Keep the screen (and with it the GPS) on while sharing; re-acquired when the page is shown again
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

    // Stop by itself when the event ends
    const endTimer = window.setTimeout(() => setSharing(false), event.endsAt.toMillis() - Date.now());

    return () => {
      navigator.geolocation.clearWatch(watch);
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => undefined);
      window.clearTimeout(endTimer);
      lastMember.current = null;
      lastPoint.current = null;
    };
  }, [sharing, event, running, userName]);

  const setOn = useCallback(
    (on: boolean) => {
      if (!eventId) return;
      try {
        if (on) localStorage.setItem(storageKey(eventId), '1');
        else localStorage.removeItem(storageKey(eventId));
      } catch {
        // private mode: sharing just doesn't resume after a reload
      }
      setSharing(on);
      if (!on) {
        setPosition(null);
        // Stopping removes me from the map; my track stays until the event ends
        deleteDoc(doc(db, `events/${eventId}/members`, userName)).catch((err) =>
          console.error('Could not remove position:', err)
        );
      }
    },
    [eventId, userName]
  );

  return { sharing: sharing && running, setSharing: setOn, status, position };
}
