import { useState } from 'react';
import './InAppBrowserNotice.css';

// Links from the sign-in email often open in Outlook's (or Teams') built-in browser, where sharing the position
// doesn't work. Detect that and offer to open the page in the phone's real browser.

const ua = navigator.userAgent;
const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

// iOS: every real browser (Safari, Chrome, Firefox, Edge) has "Safari" in its user agent; an app's web view and a
// home-screen web app don't, so a missing "Safari" outside a home-screen app means a web view inside another app.
// Android: web views mark themselves with "; wv)". Plus the apps that name themselves.
const inAppBrowser = () => {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (/Teams\/|Outlook|FBAN|FBAV|Instagram|LinkedInApp|Line\//i.test(ua)) return true;
  if (isIos) return !standalone && /AppleWebKit/.test(ua) && !/Safari\//.test(ua);
  if (isAndroid) return /; wv\)/.test(ua);
  return false;
};

const InAppBrowserNotice = () => {
  const [copied, setCopied] = useState(false);
  if (!inAppBrowser()) return null;

  const url = window.location.href;
  const browser = isAndroid ? 'Chrome' : 'Safari';
  // x-safari-https:// (iOS 17+) and Android intents open the page in the real browser; copying the link always works
  const openUrl = isAndroid
    ? `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`
    : isIos
      ? url.replace(/^https:\/\//, 'x-safari-https://')
      : url;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt('Kopiera länken:', url);
    }
  };

  return (
    <div className="in-app-notice" role="alert">
      <strong>Öppna sidan i {browser}</strong>
      <span>
        Du har öppnat TD Share inne i en app, till exempel Outlook eller Teams. Där kan du inte dela din position.
      </span>
      <div className="in-app-actions">
        <a className="primary" href={openUrl}>
          Öppna i {browser}
        </a>
        <button className="link-btn" onClick={copy}>
          {copied ? 'Länken är kopierad' : 'Kopiera länken'}
        </button>
      </div>
    </div>
  );
};

export default InAppBrowserNotice;
