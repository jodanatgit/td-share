import { useState } from 'react';
import { auth } from '../firebase';
import { initials } from '../names';
import './OwnTracksSetup.css';

// One-time setup of the OwnTracks app, which keeps sending the position with the screen off
// (functions/index.js stores it only while you share in a running event).

interface Credentials {
  username: string;
  password: string;
}

const APP_STORE = 'https://apps.apple.com/app/owntracks/id692424691';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=org.owntracks.android';

const endpoint = () => `${window.location.origin}/api/owntracks`;

// OwnTracks "remote configuration": HTTP mode, our endpoint, and "move" monitoring (frequent updates)
const configFor = ({ username, password }: Credentials) => ({
  _type: 'configuration',
  mode: 3,
  url: endpoint(),
  auth: true,
  username,
  password,
  deviceId: 'phone',
  tid: initials(username),
  monitoring: 2,
  locatorDisplacement: 25,
  locatorInterval: 30
});

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const OwnTracksSetup = ({ onBack }: { onBack: () => void }) => {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const idToken = await auth.currentUser!.getIdToken();
      const res = await fetch('/api/owntracks/token', { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCreds(await res.json());
    } catch (err) {
      console.error('Could not create OwnTracks password:', err);
      setError('Kunde inte skapa inställningarna. Försök igen.');
    } finally {
      setBusy(false);
    }
  };

  const link = creds ? `owntracks:///config?inline=${encodeURIComponent(toBase64(JSON.stringify(configFor(creds))))}` : '';

  return (
    <div className="ot">
      <button className="link-btn" onClick={onBack}>
        ‹ Tillbaka
      </button>
      <h1>Dela med skärmen av</h1>
      <p>
        Webbläsaren slutar skicka din position när skärmen släcks. Med appen <strong>OwnTracks</strong> fortsätter
        telefonen att skicka i bakgrunden. Du ställer in den en gång.
      </p>
      <p className="muted">
        Positionerna sparas bara när du har slagit på <em>Dela min position</em> i ett pågående event. Annars kastas
        de direkt.
      </p>

      <ol className="ot-steps">
        <li>
          <strong>Installera OwnTracks</strong>
          <span>
            <a href={APP_STORE} target="_blank" rel="noreferrer">
              iPhone
            </a>{' '}
            ·{' '}
            <a href={PLAY_STORE} target="_blank" rel="noreferrer">
              Android
            </a>
          </span>
        </li>
        <li>
          <strong>Skapa dina inställningar</strong>
          <span>Ett nytt lösenord gör att ett gammalt slutar fungera, till exempel på en borttappad telefon.</span>
          {!creds && (
            <button className="primary" onClick={create} disabled={busy}>
              {busy ? 'Skapar…' : 'Skapa inställningar'}
            </button>
          )}
        </li>
        <li>
          <strong>Öppna dem i OwnTracks</strong>
          <span>Gör det på telefonen. Godkänn sedan att OwnTracks får använda platsen "Alltid".</span>
          {creds && (
            <a className="primary ot-open" href={link}>
              Öppna i OwnTracks
            </a>
          )}
        </li>
        <li>
          <strong>Dela i eventet</strong>
          <span>Tryck på Dela min position i eventet. Sedan kan du släcka skärmen.</span>
        </li>
      </ol>

      {creds && (
        <details className="ot-manual">
          <summary>Fungerade inte länken? Fyll i för hand</summary>
          <p className="muted">OwnTracks → Inställningar: läge HTTP, och:</p>
          <dl>
            <dt>URL</dt>
            <dd>{endpoint()}</dd>
            <dt>Användarnamn</dt>
            <dd>{creds.username}</dd>
            <dt>Lösenord</dt>
            <dd>{creds.password}</dd>
          </dl>
          <p className="muted">Lösenordet visas bara nu.</p>
        </details>
      )}

      {error && <p className="error">{error}</p>}

      <p className="muted ot-battery">
        Tips: OwnTracks läge "Move" ger täta uppdateringar men drar mer batteri. Byt till "Significant" eller "Quiet" i
        appen när eventet är slut.
      </p>
    </div>
  );
};

export default OwnTracksSetup;
