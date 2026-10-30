import React, { useState } from 'react';
import './PlaceForm.css';

interface PlaceFormProps {
  initial?: { title: string; info: string };
  kind?: 'place' | 'route'; // a drawn route only gets a name
  onSave: (title: string, info: string) => Promise<void>;
  onCancel: () => void;
}

// Title and info for a place on the map (new or edited), or the name of a route drawn on the map
const PlaceForm = ({ initial, kind = 'place', onSave, onCancel }: PlaceFormProps) => {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [info, setInfo] = useState(initial?.info ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSave(title.trim().slice(0, 80), info.trim().slice(0, 2000));
    } catch (err) {
      console.error(`Could not save ${kind}:`, err);
      setError(kind === 'route' ? 'Kunde inte spara rutten. Försök igen.' : 'Kunde inte spara platsen. Försök igen.');
      setBusy(false);
    }
  };

  return (
    <div className="place-form-overlay" onClick={onCancel}>
      <form className="place-form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{kind === 'route' ? 'Ny rutt' : initial ? 'Ändra plats' : 'Ny plats'}</h2>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'route' ? 'T.ex. Löparrundan, Vägen till middagen' : 'T.ex. Samling, Lunch, Hotellet'}
          maxLength={80}
          autoFocus
        />
        {kind === 'place' && (
          <textarea
            value={info}
            onChange={(e) => setInfo(e.target.value)}
            placeholder="Info, t.ex. tider, vägbeskrivning eller en länk"
            maxLength={2000}
            rows={5}
          />
        )}
        {error && <p className="error">{error}</p>}
        <div className="place-form-actions">
          <button type="button" className="link-btn" onClick={onCancel}>
            Avbryt
          </button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? 'Sparar…' : 'Spara'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default PlaceForm;
