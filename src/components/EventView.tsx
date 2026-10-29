import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentReference
} from 'firebase/firestore';
import { db } from '../firebase';
import { useLocationSharing } from '../hooks/useLocationSharing';
import { ago, colorFor, displayName, initials } from '../names';
import type { Member, TdEvent, TrackPoint } from '../types';
import './EventView.css';

interface EventViewProps {
  eventId: string;
  userName: string;
  onBack: () => void;
}

const STALE_MS = 5 * 60 * 1000; // a position older than this is shown faded

const markerIcon = (userName: string, me: boolean, stale: boolean) =>
  L.divIcon({
    className: '',
    html: `<div class="person-marker${me ? ' me' : ''}${stale ? ' stale' : ''}" style="--c:${colorFor(userName)}">${initials(userName)}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });

// Fit the map to everyone the first time positions arrive; after that the user pans freely
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !points.length) return;
    done.current = true;
    if (points.length === 1) map.setView(points[0], 16);
    else map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 17 });
  }, [map, points]);
  return null;
}

function FlyTo({ target }: { target: { lat: number; lng: number; n: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 16));
  }, [map, target]);
  return null;
}

const EventView = ({ eventId, userName, onBack }: EventViewProps) => {
  const [event, setEvent] = useState<TdEvent | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [showTracks, setShowTracks] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; n: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState(false);
  const { sharing, setSharing, status, position } = useLocationSharing(event ?? null, userName);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'events', eventId),
        (snap) => setEvent(snap.exists() ? ({ id: snap.id, ...snap.data() } as TdEvent) : null),
        () => setEvent(null)
      ),
    [eventId]
  );

  const running = !!event && event.endsAt.toMillis() > now;

  // Positions and tracks can only be read while the event runs (firestore.rules)
  useEffect(() => {
    if (!running) return;
    const unsubMembers = onSnapshot(
      collection(db, `events/${eventId}/members`),
      (snap) =>
        setMembers(
          snap.docs.map((d) => {
            const x = d.data();
            return { userName: d.id, lat: x.lat, lng: x.lng, accuracy: x.accuracy, updatedAt: x.updatedAt?.toDate() ?? null };
          })
        ),
      (err) => console.error('members listener failed:', err)
    );
    const unsubPoints = onSnapshot(
      query(collection(db, `events/${eventId}/points`), orderBy('at'), limit(20000)),
      (snap) =>
        setPoints(
          snap.docs.map((d) => {
            const x = d.data();
            return { userName: x.userName, lat: x.lat, lng: x.lng, at: x.at?.toDate() ?? null };
          })
        ),
      (err) => console.error('points listener failed:', err)
    );
    return () => {
      unsubMembers();
      unsubPoints();
    };
  }, [eventId, running]);

  const tracks = useMemo(() => {
    const byUser = new Map<string, [number, number][]>();
    for (const p of points) {
      if (!byUser.has(p.userName)) byUser.set(p.userName, []);
      byUser.get(p.userName)!.push([p.lat, p.lng]);
    }
    return [...byUser.entries()].filter(([, line]) => line.length > 1);
  }, [points]);

  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => (a.userName === userName ? -1 : b.userName === userName ? 1 : a.userName.localeCompare(b.userName))),
    [members, userName]
  );
  const fitPoints = useMemo(() => members.map((m) => [m.lat, m.lng] as [number, number]), [members]);

  const isCreator = event?.createdBy === userName;

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Kopiera länken:', window.location.href);
    }
  };

  // Ending early deletes everyone's positions and tracks right away, then closes the event
  const endEvent = async () => {
    if (!event || !window.confirm(`Avsluta "${event.name}"? Alla positioner och spår raderas.`)) return;
    setEnding(true);
    try {
      setSharing(false);
      for (const sub of ['points', 'members']) {
        const snap = await getDocs(collection(db, `events/${eventId}/${sub}`));
        const refs: DocumentReference[] = snap.docs.map((d) => d.ref);
        for (let i = 0; i < refs.length; i += 400) {
          const batch = writeBatch(db);
          refs.slice(i, i + 400).forEach((r) => batch.delete(r));
          await batch.commit();
        }
      }
      const endedAt = Timestamp.now();
      await updateDoc(doc(db, 'events', eventId), { endsAt: endedAt, expireAt: endedAt });
      onBack();
    } catch (err) {
      console.error('Could not end event:', err);
      window.alert('Kunde inte avsluta eventet. Försök igen.');
      setEnding(false);
    }
  };

  if (event === undefined) return <div className="event-message">Laddar…</div>;
  if (event === null || !running)
    return (
      <div className="event-message">
        <p>{event ? `"${event.name}" är slut.` : 'Eventet finns inte längre.'}</p>
        <button className="primary" onClick={onBack}>
          Till eventen
        </button>
      </div>
    );

  const statusText: Record<typeof status, string> = {
    off: 'Du delar inte din position',
    starting: 'Hämtar din position…',
    on: position ? `Du delar din position (±${position.accuracy} m)` : 'Du delar din position',
    denied: 'Platsåtkomst nekad. Tillåt plats för sidan i webbläsarens inställningar.',
    unavailable: 'Den här webbläsaren kan inte dela position.',
    error: 'Kunde inte hämta eller dela positionen just nu.'
  };

  return (
    <div className="event-view">
      <header className="event-bar">
        <button className="icon-btn" onClick={onBack} aria-label="Till eventen">
          ‹
        </button>
        <div className="event-title">
          <strong>{event.name}</strong>
          <span>
            slutar {event.endsAt.toDate().toLocaleString('sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <button className="small-btn" onClick={share}>
          {copied ? 'Kopierad!' : 'Dela länk'}
        </button>
      </header>

      <MapContainer className="event-map" center={[59.33, 18.07]} zoom={5} zoomControl={false}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
        />
        <FitOnce points={fitPoints} />
        <FlyTo target={flyTarget} />
        {showTracks &&
          tracks.map(([name, line]) => (
            <Polyline key={name} positions={line} pathOptions={{ color: colorFor(name), weight: 4, opacity: 0.6 }} />
          ))}
        {sortedMembers.map((m) => {
          const stale = !m.updatedAt || now - m.updatedAt.getTime() > STALE_MS;
          return (
            <Marker key={m.userName} position={[m.lat, m.lng]} icon={markerIcon(m.userName, m.userName === userName, stale)}>
              <Popup>
                <strong>{displayName(m.userName)}</strong>
                <br />
                {ago(m.updatedAt, now)} · ±{m.accuracy} m
              </Popup>
            </Marker>
          );
        })}
        {position && (
          <Circle
            center={[position.lat, position.lng]}
            radius={position.accuracy}
            pathOptions={{ color: colorFor(userName), weight: 1, fillOpacity: 0.08 }}
          />
        )}
      </MapContainer>

      <section className="event-sheet">
        <div className="share-row">
          <span className={`status status-${status}`}>{statusText[status]}</span>
          <button className={sharing ? 'stop' : 'primary'} onClick={() => setSharing(!sharing)}>
            {sharing ? 'Sluta dela' : 'Dela min position'}
          </button>
        </div>
        {sharing && <p className="hint">Ha skärmen på och sidan öppen, annars pausar telefonen GPS:en.</p>}

        <ul className="people">
          {sortedMembers.length === 0 && <li className="muted">Ingen delar sin position ännu.</li>}
          {sortedMembers.map((m) => (
            <li key={m.userName}>
              <button onClick={() => setFlyTarget({ lat: m.lat, lng: m.lng, n: Date.now() })}>
                <span className="dot" style={{ background: colorFor(m.userName) }} />
                <span className="name">{m.userName === userName ? 'Du' : displayName(m.userName)}</span>
                <span className="muted">{ago(m.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="sheet-footer">
          <label>
            <input type="checkbox" checked={showTracks} onChange={(e) => setShowTracks(e.target.checked)} /> Visa spår
          </label>
          {isCreator && (
            <button className="link-btn danger" onClick={endEvent} disabled={ending}>
              {ending ? 'Avslutar…' : 'Avsluta event'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

export default EventView;
