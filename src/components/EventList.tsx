import React, { useEffect, useState } from 'react';
import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp, Timestamp, where } from 'firebase/firestore';
import { db } from '../firebase';
import { signOutUser } from '../auth';
import { displayName } from '../names';
import type { TdEvent } from '../types';
import './EventList.css';

interface EventListProps {
  userName: string;
  onOpen: (eventId: string) => void;
}

const HOUR = 3600 * 1000;

// How long a new event runs. The rules allow at most three days.
const DURATIONS: { label: string; end: () => Date }[] = [
  { label: '2 timmar', end: () => new Date(Date.now() + 2 * HOUR) },
  { label: '4 timmar', end: () => new Date(Date.now() + 4 * HOUR) },
  {
    label: 'Resten av dagen',
    end: () => {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      return d.getTime() - Date.now() < HOUR ? new Date(Date.now() + HOUR) : d;
    }
  },
  { label: '2 dagar', end: () => new Date(Date.now() + 48 * HOUR) },
  { label: '3 dagar', end: () => new Date(Date.now() + 72 * HOUR) }
];

const formatEnd = (d: Date) =>
  d.toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const EventList = ({ userName, onOpen }: EventListProps) => {
  const [events, setEvents] = useState<TdEvent[] | null>(null);
  const [name, setName] = useState('');
  const [duration, setDuration] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Running events only; ended ones can no longer be read in detail and are deleted automatically
  useEffect(() => {
    const q = query(collection(db, 'events'), where('endsAt', '>', Timestamp.now()), orderBy('endsAt'));
    return onSnapshot(
      q,
      (snap) => setEvents(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TdEvent, 'id'>) }))),
      (err) => {
        console.error('events listener failed:', err);
        setError('Kunde inte läsa eventen just nu.');
      }
    );
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    setError('');
    try {
      const endsAt = Timestamp.fromDate(DURATIONS[duration].end());
      const ref = await addDoc(collection(db, 'events'), {
        name: clean.slice(0, 80),
        createdBy: userName,
        createdAt: serverTimestamp(),
        endsAt,
        expireAt: endsAt
      });
      onOpen(ref.id);
    } catch (err) {
      console.error('Could not create event:', err);
      setError('Kunde inte skapa eventet. Försök igen.');
      setBusy(false);
    }
  };

  return (
    <div className="event-list">
      <header className="event-list-header">
        <h1>TD Share</h1>
        <button className="link-btn" onClick={() => signOutUser()}>
          Logga ut {displayName(userName)}
        </button>
      </header>

      <p className="event-list-intro">
        Se var kollegorna är under en workshop eller konferens. Du delar bara din position när du själv slår på det,
        och allt raderas när eventet är slut.
      </p>

      <section>
        <h2>Pågående event</h2>
        {events === null && !error && <p className="muted">Laddar…</p>}
        {events?.length === 0 && <p className="muted">Inga event just nu. Skapa ett nedan.</p>}
        <ul className="event-cards">
          {events?.map((ev) => (
            <li key={ev.id}>
              <button onClick={() => onOpen(ev.id)}>
                <strong>{ev.name}</strong>
                <span className="muted">
                  {displayName(ev.createdBy)} · slutar {formatEnd(ev.endsAt.toDate())}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Nytt event</h2>
        <form className="event-form" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="T.ex. Workshop Göteborg" maxLength={80} />
          <div className="durations" role="radiogroup" aria-label="Hur länge">
            {DURATIONS.map((d, i) => (
              <button
                type="button"
                key={d.label}
                role="radio"
                aria-checked={duration === i}
                className={duration === i ? 'active' : ''}
                onClick={() => setDuration(i)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            Skapa event
          </button>
        </form>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
};

export default EventList;
