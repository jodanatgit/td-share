import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './firebase';
import { isAllowedUser, nameFromEmail } from './auth';
import SignIn from './components/SignIn';
import EventList from './components/EventList';
import EventView from './components/EventView';

// The open event lives in the address (#/e/<id>), so a link to it can be shared in Teams
const eventFromHash = () => window.location.hash.match(/^#\/e\/([\w-]+)$/)?.[1] ?? null;

// Only signed-in @totaldigital.se users get past this gate; nothing below it touches Firestore before then
function App() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [eventId, setEventId] = useState(eventFromHash);

  useEffect(() => onAuthStateChanged(auth, setAuthUser), []);
  useEffect(() => {
    const onHash = () => setEventId(eventFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (authUser === undefined) return null; // restoring session
  if (!isAllowedUser(authUser)) return <SignIn rejectedEmail={authUser?.email} />;

  const userName = nameFromEmail(authUser!.email!);
  const open = (id: string | null) => {
    window.location.hash = id ? `/e/${id}` : '';
  };
  return eventId ? (
    <EventView key={eventId} eventId={eventId} userName={userName} onBack={() => open(null)} />
  ) : (
    <EventList userName={userName} onOpen={open} />
  );
}

export default App;
