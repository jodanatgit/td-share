import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, CircleMarker, LayerGroup, LayersControl, MapContainer, Marker, Polyline, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentReference
} from 'firebase/firestore';
import { db } from '../firebase';
import { useLocationSharing } from '../hooks/useLocationSharing';
import { ago, colorFor, displayName, initials } from '../names';
import { parseGpx, toLines } from '../gpx';
import MapLayers from './MapLayers';
import PlaceForm from './PlaceForm';
import InAppBrowserNotice from './InAppBrowserNotice';
import type { Member, Place, Route, TdEvent, TrackPoint } from '../types';
import './EventView.css';

interface EventViewProps {
  eventId: string;
  userName: string;
  onBack: () => void;
}

const STALE_MS = 5 * 60 * 1000; // a position older than this is shown faded
const MAX_GPX_BYTES = 10 * 1024 * 1024;
const ROUTE_COLORS = ['#1d4ed8', '#b91c1c', '#047857', '#7c3aed', '#c2410c', '#0f766e', '#be185d', '#4d7c0f'];

const markerIcon = (userName: string, me: boolean, stale: boolean) =>
  L.divIcon({
    className: '',
    html: `<div class="person-marker${me ? ' me' : ''}${stale ? ' stale' : ''}" style="--c:${colorFor(userName)}">${initials(userName)}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });

const placeIcon = L.divIcon({
  className: '',
  html: '<div class="place-marker"><svg viewBox="0 0 24 32" width="30" height="40"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20.4 12 32 12 32s12-11.6 12-20.3C24 5.2 18.6 0 12 0z" fill="#14202b"/><circle cx="12" cy="11.5" r="4.5" fill="#e8762a"/></svg></div>',
  iconSize: [30, 40],
  iconAnchor: [15, 40],
  popupAnchor: [0, -36]
});

// Plain text with clickable links and kept line breaks
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <span className="linkified">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          p
        )
      )}
    </span>
  );
}

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

type Focus = { points: [number, number][]; n: number } | null;

// Zoom to one point or a set of points (a route) when asked to
function FocusOn({ focus }: { focus: Focus }) {
  const map = useMap();
  useEffect(() => {
    if (!focus || !focus.points.length) return;
    if (focus.points.length === 1) map.flyTo(focus.points[0], Math.max(map.getZoom(), 16));
    else map.flyToBounds(L.latLngBounds(focus.points), { padding: [40, 40], maxZoom: 17 });
  }, [map, focus]);
  return null;
}

// While adding a place, the next tap on the map picks its position
function PickPosition({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

const EventView = ({ eventId, userName, onBack }: EventViewProps) => {
  const [event, setEvent] = useState<TdEvent | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [now, setNow] = useState(Date.now());
  const [focus, setFocus] = useState<Focus>(null);
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ lat: number; lng: number } | null>(null);
  const [editing, setEditing] = useState<Place | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const { sharing, loaded, deviceGps, setDeviceGps, setSharing, status, position } = useLocationSharing(event ?? null, userName);

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

  // Everything inside an event can only be read while it runs (firestore.rules)
  useEffect(() => {
    if (!running) return;
    const base = `events/${eventId}`;
    const unsubs = [
      onSnapshot(
        collection(db, `${base}/members`),
        (snap) =>
          setMembers(
            snap.docs.map((d) => {
              const x = d.data();
              return { userName: d.id, lat: x.lat, lng: x.lng, accuracy: x.accuracy, updatedAt: x.updatedAt?.toDate() ?? null };
            })
          ),
        (err) => console.error('members listener failed:', err)
      ),
      onSnapshot(
        query(collection(db, `${base}/points`), orderBy('at'), limit(20000)),
        (snap) =>
          setPoints(
            snap.docs.map((d) => {
              const x = d.data();
              return { userName: x.userName, lat: x.lat, lng: x.lng, at: x.at?.toDate() ?? null };
            })
          ),
        (err) => console.error('points listener failed:', err)
      ),
      onSnapshot(
        query(collection(db, `${base}/places`), orderBy('createdAt')),
        (snap) => setPlaces(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Place, 'id'>) }))),
        (err) => console.error('places listener failed:', err)
      ),
      onSnapshot(
        query(collection(db, `${base}/routes`), orderBy('createdAt')),
        (snap) => setRoutes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Route, 'id'>) }))),
        (err) => console.error('routes listener failed:', err)
      )
    ];
    return () => unsubs.forEach((u) => u());
  }, [eventId, running]);

  const tracks = useMemo(() => {
    const byUser = new Map<string, [number, number][]>();
    for (const p of points) {
      if (!byUser.has(p.userName)) byUser.set(p.userName, []);
      byUser.get(p.userName)!.push([p.lat, p.lng]);
    }
    return [...byUser.entries()].filter(([, line]) => line.length > 1);
  }, [points]);

  const routeLines = useMemo(() => routes.map((r) => ({ route: r, lines: toLines(r.coords, r.breaks) })), [routes]);

  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => (a.userName === userName ? -1 : b.userName === userName ? 1 : a.userName.localeCompare(b.userName))),
    [members, userName]
  );
  const fitPoints = useMemo(
    () => [
      ...members.map((m) => [m.lat, m.lng] as [number, number]),
      ...places.map((p) => [p.lat, p.lng] as [number, number])
    ],
    [members, places]
  );

  const isCreator = event?.createdBy === userName;
  const canDelete = (createdBy: string) => createdBy === userName || isCreator;

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(''), 4000);
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Kopiera länken:', window.location.href);
    }
  };

  const savePlace = async (title: string, info: string) => {
    if (editing) {
      await updateDoc(doc(db, `events/${eventId}/places`, editing.id), { title, info });
      setEditing(null);
      return;
    }
    if (!draft || !event) return;
    await addDoc(collection(db, `events/${eventId}/places`), {
      title,
      info,
      lat: draft.lat,
      lng: draft.lng,
      createdBy: userName,
      createdAt: serverTimestamp(),
      expireAt: event.endsAt
    });
    setDraft(null);
  };

  const removePlace = async (p: Place) => {
    if (!window.confirm(`Ta bort "${p.title}"?`)) return;
    await deleteDoc(doc(db, `events/${eventId}/places`, p.id)).catch((err) => {
      console.error('Could not delete place:', err);
      flash('Kunde inte ta bort platsen.');
    });
  };

  const uploadGpx = async (file: File) => {
    if (!event) return;
    if (file.size > MAX_GPX_BYTES) {
      flash('Filen är för stor (max 10 MB).');
      return;
    }
    setUploading(true);
    try {
      const gpx = parseGpx(await file.text(), file.name);
      await addDoc(collection(db, `events/${eventId}/routes`), {
        ...gpx,
        color: ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
        createdBy: userName,
        createdAt: serverTimestamp(),
        expireAt: event.endsAt
      });
      const all = [...toLines(gpx.coords, gpx.breaks).flat(), ...gpx.waypoints.map((w) => [w.lat, w.lng] as [number, number])];
      setFocus({ points: all, n: Date.now() });
      flash(`"${gpx.name}" är uppladdad.`);
    } catch (err) {
      console.error('GPX upload failed:', err);
      flash(err instanceof Error && err.message.endsWith('.') ? err.message : 'Kunde inte ladda upp filen.');
    } finally {
      setUploading(false);
    }
  };

  const removeRoute = async (r: Route) => {
    if (!window.confirm(`Ta bort rutten "${r.name}"?`)) return;
    await deleteDoc(doc(db, `events/${eventId}/routes`, r.id)).catch((err) => {
      console.error('Could not delete route:', err);
      flash('Kunde inte ta bort rutten.');
    });
  };

  // Ending early deletes everything in the event right away, then closes it
  const endEvent = async () => {
    if (!event || !window.confirm(`Avsluta "${event.name}"? Alla positioner, spår, platser och rutter raderas.`)) return;
    setEnding(true);
    try {
      setSharing(false);
      for (const sub of ['points', 'members', 'places', 'routes']) {
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
    remote: 'Du delar din position via OwnTracks eller en annan enhet',
    starting: 'Hämtar din position…',
    on: position ? `Du delar din position (±${position.accuracy} m)` : 'Du delar din position',
    denied: 'Platsåtkomst nekad. Tillåt plats för sidan i webbläsarens inställningar, och använd Safari eller Chrome.',
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

      <div className={`event-map-wrap${adding ? ' adding' : ''}`}>
        {adding && (
          <div className="map-banner" role="status">
            <span>Tryck på kartan där platsen ska vara</span>
            <button className="link-btn" onClick={() => setAdding(false)}>
              Avbryt
            </button>
          </div>
        )}
        {notice && <div className="map-notice">{notice}</div>}

        <MapContainer className="event-map" center={[59.33, 18.07]} zoom={5} zoomControl={false}>
          <MapLayers>
            <LayersControl.Overlay name="Livespår" checked>
              <LayerGroup>
                {tracks.map(([name, line]) => (
                  <Polyline key={name} positions={line} pathOptions={{ color: colorFor(name), weight: 4, opacity: 0.6 }} />
                ))}
              </LayerGroup>
            </LayersControl.Overlay>
            <LayersControl.Overlay name="GPX-rutter" checked>
              <LayerGroup>
                {routeLines.map(({ route, lines }) => (
                  <LayerGroup key={route.id}>
                    {lines.map((line, i) => (
                      <Polyline key={i} positions={line} pathOptions={{ color: route.color, weight: 5, opacity: 0.85, dashArray: '10 8' }}>
                        <Tooltip sticky>{route.name}</Tooltip>
                      </Polyline>
                    ))}
                    {route.waypoints.map((w, i) => (
                      <CircleMarker
                        key={`w${i}`}
                        center={[w.lat, w.lng]}
                        radius={6}
                        pathOptions={{ color: '#fff', weight: 2, fillColor: route.color, fillOpacity: 1 }}
                      >
                        {w.name && <Tooltip>{w.name}</Tooltip>}
                      </CircleMarker>
                    ))}
                  </LayerGroup>
                ))}
              </LayerGroup>
            </LayersControl.Overlay>
            <LayersControl.Overlay name="Platser" checked>
              <LayerGroup>
                {places.map((p) => (
                  <Marker key={p.id} position={[p.lat, p.lng]} icon={placeIcon}>
                    <Popup>
                      <div className="place-popup">
                        <strong>{p.title}</strong>
                        {p.info && <Linkified text={p.info} />}
                        <span className="muted">Tillagd av {displayName(p.createdBy)}</span>
                        <span className="place-popup-actions">
                          {p.createdBy === userName && (
                            <button className="link-btn" onClick={() => setEditing(p)}>
                              Ändra
                            </button>
                          )}
                          {canDelete(p.createdBy) && (
                            <button className="link-btn danger" onClick={() => removePlace(p)}>
                              Ta bort
                            </button>
                          )}
                        </span>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </LayerGroup>
            </LayersControl.Overlay>
          </MapLayers>
          <FitOnce points={fitPoints} />
          <FocusOn focus={focus} />
          {adding && (
            <PickPosition
              onPick={(lat, lng) => {
                setAdding(false);
                setDraft({ lat, lng });
              }}
            />
          )}
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
          {draft && <Marker position={[draft.lat, draft.lng]} icon={placeIcon} />}
        </MapContainer>
      </div>

      <section className="event-sheet">
        <InAppBrowserNotice />
        <div className="share-row">
          <span className={`status status-${status}`}>{statusText[status]}</span>
          <button className={sharing ? 'stop' : 'primary'} onClick={() => setSharing(!sharing)} disabled={!loaded}>
            {sharing ? 'Sluta dela' : 'Dela min position'}
          </button>
        </div>
        {sharing && deviceGps && (
          <p className="hint">
            Webbläsaren pausar GPS:en när skärmen släcks. <a href="#/owntracks">Ställ in OwnTracks</a> för att dela med
            skärmen av.
          </p>
        )}
        {sharing && !deviceGps && (
          <p className="hint">
            <button className="link-btn" onClick={() => setDeviceGps(true)}>
              Använd också den här enhetens GPS
            </button>
          </p>
        )}

        <div className="tools">
          <button onClick={() => setAdding(true)} disabled={adding}>
            + Plats
          </button>
          <button onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? 'Laddar upp…' : '+ GPX-fil'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".gpx,application/gpx+xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) uploadGpx(f);
            }}
          />
        </div>

        <h3 className="sheet-heading">Personer</h3>
        <ul className="people">
          {sortedMembers.length === 0 && <li className="muted">Ingen delar sin position ännu.</li>}
          {sortedMembers.map((m) => (
            <li key={m.userName}>
              <button onClick={() => setFocus({ points: [[m.lat, m.lng]], n: Date.now() })}>
                <span className="dot" style={{ background: colorFor(m.userName) }} />
                <span className="name">{m.userName === userName ? 'Du' : displayName(m.userName)}</span>
                <span className="muted">{ago(m.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>

        {places.length > 0 && (
          <>
            <h3 className="sheet-heading">Platser</h3>
            <ul className="people">
              {places.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setFocus({ points: [[p.lat, p.lng]], n: Date.now() })}>
                    <span className="pin" aria-hidden="true" />
                    <span className="name">{p.title}</span>
                    <span className="muted">{displayName(p.createdBy)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {routeLines.length > 0 && (
          <>
            <h3 className="sheet-heading">Rutter</h3>
            <ul className="people">
              {routeLines.map(({ route, lines }) => (
                <li key={route.id} className="with-action">
                  <button
                    onClick={() =>
                      setFocus({ points: [...lines.flat(), ...route.waypoints.map((w) => [w.lat, w.lng] as [number, number])], n: Date.now() })
                    }
                  >
                    <span className="line" style={{ background: route.color }} />
                    <span className="name">{route.name}</span>
                    <span className="muted">{displayName(route.createdBy)}</span>
                  </button>
                  {canDelete(route.createdBy) && (
                    <button className="remove" onClick={() => removeRoute(route)} aria-label={`Ta bort ${route.name}`}>
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {isCreator && (
          <div className="sheet-footer">
            <button className="link-btn danger" onClick={endEvent} disabled={ending}>
              {ending ? 'Avslutar…' : 'Avsluta event'}
            </button>
          </div>
        )}
      </section>

      {(draft || editing) && (
        <PlaceForm
          initial={editing ? { title: editing.title, info: editing.info } : undefined}
          onSave={savePlace}
          onCancel={() => {
            setDraft(null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

export default EventView;
