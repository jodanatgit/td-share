import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './firebase';
import { isAllowedUser, nameFromEmail } from './auth';
import SignIn from './components/SignIn';
import EventList from './components/EventList';
import EventView from './components/EventView';
import OwnTracksSetup from './components/OwnTracksSetup';

// The open page lives in the address: #/e/<id> is an event (a link to it can be shared in Teams),
// #/owntracks the background-sharing setup
const routeFromHash = () => {
  if (window.location.hash === '#/owntracks') return { page: 'owntracks' as const, eventId: null };
  return { page: 'main' as const, eventId: window.location.hash.match(/^#\/e\/([\w-]+)$/)?.[1] ?? null };
};

// Only signed-in @totaldigital.se users get past this gate; nothing below it touches Firestore before then
function App() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => onAuthStateChanged(auth, setAuthUser), []);
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (authUser === undefined) return null; // restoring session
  if (!isAllowedUser(authUser)) return <SignIn rejectedEmail={authUser?.email} />;

  const userName = nameFromEmail(authUser!.email!);
  const open = (id: string | null) => {
    window.location.hash = id ? `/e/${id}` : '';
  };
  if (route.page === 'owntracks') return <OwnTracksSetup onBack={() => open(null)} />;
  return route.eventId ? (
    <EventView key={route.eventId} eventId={route.eventId} userName={userName} onBack={() => open(null)} />
  ) : (
    <EventList userName={userName} onOpen={open} />
  );
}

export default App;
