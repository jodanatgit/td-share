import React, { useEffect, useState } from 'react';
import {
  ALLOWED_EMAIL_DOMAIN,
  completeSignInLink,
  isAllowedEmail,
  isSignInLink,
  sendSignInLink,
  signOutUser,
  storedSignInEmail
} from '../auth';
import './NamePrompt.css';

interface SignInProps {
  // Set when someone is signed in with an address outside the allowed domain
  rejectedEmail?: string | null;
}

type Step = 'enter' | 'sent' | 'confirm' | 'working';

const SignIn = ({ rejectedEmail }: SignInProps) => {
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>('enter');
  const [error, setError] = useState('');

  // Opened from the link in the email: finish signing in
  useEffect(() => {
    if (!isSignInLink()) return;
    const saved = storedSignInEmail();
    if (!saved) {
      setStep('confirm');
      return;
    }
    setStep('working');
    completeSignInLink(saved).catch((e) => {
      console.error('Email link sign-in failed:', e);
      setError('Länken är ogiltig eller har gått ut. Begär en ny.');
      setStep('enter');
    });
  }, []);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!isAllowedEmail(email)) {
      setError(`Använd din @${ALLOWED_EMAIL_DOMAIN}-adress.`);
      return;
    }
    setStep('working');
    try {
      await sendSignInLink(email);
      setStep('sent');
    } catch (err) {
      console.error('Could not send sign-in link:', err);
      setError('Kunde inte skicka länken. Försök igen.');
      setStep('enter');
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStep('working');
    try {
      await completeSignInLink(email);
    } catch (err) {
      console.error('Email link sign-in failed:', err);
      setError('Fel e-postadress, eller så har länken gått ut.');
      setStep('confirm');
    }
  };

  return (
    <div className="name-prompt-overlay">
      <div className="name-prompt-modal">
        <h2>Välkommen!</h2>

        {rejectedEmail && (
          <p className="sign-in-error">
            {rejectedEmail} har inte tillgång. Logga in med din @{ALLOWED_EMAIL_DOMAIN}-adress.{' '}
            <button type="button" className="sign-in-link-btn" onClick={() => signOutUser()}>
              Logga ut
            </button>
          </p>
        )}

        {step === 'sent' && (
          <>
            <p>
              Vi har skickat en inloggningslänk till <strong>{email.trim().toLowerCase()}</strong>. Öppna mejlet och
              klicka på länken. Hittar du det inte? Kolla skräpposten.
            </p>
            <button type="button" className="sign-in-link-btn" onClick={() => setStep('enter')}>
              Använd en annan adress
            </button>
          </>
        )}

        {step === 'working' && <p>Ett ögonblick…</p>}

        {(step === 'enter' || step === 'confirm') && !rejectedEmail && (
          <>
            <p>
              {step === 'confirm'
                ? 'Bekräfta din e-postadress för att slutföra inloggningen.'
                : `Logga in med din @${ALLOWED_EMAIL_DOMAIN}-adress. Du får en länk via mejl.`}
            </p>
            <form onSubmit={step === 'confirm' ? handleConfirm : handleSend}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={`fornamn@${ALLOWED_EMAIL_DOMAIN}`}
                autoComplete="email"
                autoFocus
              />
              <button type="submit">{step === 'confirm' ? 'Logga in' : 'Skicka inloggningslänk'}</button>
            </form>
          </>
        )}

        {error && <p className="sign-in-error">{error}</p>}
      </div>
    </div>
  );
};

export default SignIn;
