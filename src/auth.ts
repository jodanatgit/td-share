import {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  type User
} from 'firebase/auth';
import { auth } from './firebase';

// Only Total Digital mailboxes may use the app. Firestore/Storage rules enforce the same check.
export const ALLOWED_EMAIL_DOMAIN = 'totaldigital.se';
const EMAIL_FOR_SIGN_IN_KEY = 'emailForSignIn';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  return !!email && normalizeEmail(email).endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

export function isAllowedUser(user: User | null): boolean {
  return !!user && user.emailVerified && isAllowedEmail(user.email);
}

// People whose first name is shared with a colleague keep their full firstname.lastname as user name
// (the plain first name belongs to the other person). Add here when a new name clash appears.
const FULL_NAME_USERS = ['hanna.swedenklef', 'daniel.sedell'];

// The app-wide user name. Everyone has both firstname@ and firstname.lastname@ mailboxes, so both
// map to the first name (johan.daniels@totaldigital.se -> johan), except for FULL_NAME_USERS.
export function nameFromEmail(email: string): string {
  const prefix = normalizeEmail(email).split('@')[0];
  if (FULL_NAME_USERS.includes(prefix)) return prefix;
  return prefix.split('.')[0];
}

export async function sendSignInLink(email: string): Promise<void> {
  const clean = normalizeEmail(email);
  if (!isAllowedEmail(clean)) {
    throw new Error(`Endast @${ALLOWED_EMAIL_DOMAIN}-adresser kan logga in.`);
  }
  await sendSignInLinkToEmail(auth, clean, {
    url: window.location.origin + window.location.pathname,
    handleCodeInApp: true
  });
  try {
    localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, clean);
  } catch {
    // Private mode: the user is asked for the email again when opening the link
  }
}

export function isSignInLink(): boolean {
  return isSignInWithEmailLink(auth, window.location.href);
}

export function storedSignInEmail(): string | null {
  try {
    return localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY);
  } catch {
    return null;
  }
}

// Completes sign-in from the link in the email. `email` is required when the link is opened
// on another device/browser than the one that requested it.
export async function completeSignInLink(email: string): Promise<void> {
  await signInWithEmailLink(auth, normalizeEmail(email), window.location.href);
  try {
    localStorage.removeItem(EMAIL_FOR_SIGN_IN_KEY);
  } catch {
    // ignore
  }
  // Drop the one-time sign-in parameters from the address bar
  window.history.replaceState(null, '', window.location.origin + window.location.pathname);
}

export function signOutUser(): Promise<void> {
  return signOut(auth);
}
