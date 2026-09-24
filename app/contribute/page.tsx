'use client';
// PHASE 3.2, "Help us map it" lightweight contribution form.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ChevronLeft, Send, CheckCircle2 } from 'lucide-react';
import { AppMenu } from '@/components/AppMenu';
import { saveCapture, syncCaptures, newId, type MapRequest } from '@/lib/capture/store';

export default function Contribute() {
  const [destination, setDestination] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Prefill from ?q= (what they searched for in the public app). Read from window so we don't need
  // a Suspense boundary around useSearchParams.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setDestination(q);
  }, []);

  const submit = async () => {
    if (!destination.trim()) return;
    setBusy(true);
    try {
      const rec: MapRequest = {
        id: newId('map-request'),
        kind: 'map-request',
        createdAt: Date.now(),
        destination: destination.trim(),
        detail: detail.trim(),
        synced: false,
      };
      await saveCapture(rec);
      await syncCaptures(); // best-effort; stays queued if offline / metered
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tg-app">
      <header className="tg-header glass glass--blur">
        <div className="tg-header-in tg-topbar">
          <Link className="tg-brand" href="/">
            <span className="tg-brand-logo-wrap">
              <Image src="/img/trotro-logo.png" alt="" width={75} height={75} className="tg-brand-logo" priority />
            </span>
            <span className="tg-brand-name">TroTro<span className="tg-brand-accent">Guide</span></span>
          </Link>
          <AppMenu />
        </div>
      </header>
      <main className="tg-main">
        {done ? (
          <div className="tg-card glass tg-rise">
            <div className="tg-empty">
              <CheckCircle2 size={44} strokeWidth={1.25} className="ico" style={{ color: 'var(--color-primary)' }} aria-hidden="true" />
              <h3 className="tg-h3">Thanks! We&rsquo;ll prioritize this area.</h3>
              <p className="tg-meta">Saved on your phone, sent as soon as you&rsquo;re online.</p>
              <Link className="tg-btn tg-btn--primary" href="/">
                <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
                Back to search
              </Link>
            </div>
          </div>
        ) : (
          <section className="tg-rise">
            <Link className="tg-back" href="/">
              <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
              back
            </Link>

            <div className="tg-herobanner">
              <Image
                src="/img/mate-in-yellow-trotro.jpg"
                alt="A trotro mate leaning out of a yellow trotro in Accra traffic"
                fill
                priority
                sizes="(max-width: 480px) 100vw, 480px"
                className="tg-herobanner-img"
              />
              <div className="tg-herobanner-content">
                <h1 className="tg-where-title">This area isn&rsquo;t mapped yet</h1>
                <p className="tg-homesub">Tried to go somewhere we haven&rsquo;t covered? Tell us where to map next.</p>
              </div>
            </div>

            <label className="tg-field">
              <span>Where did you try to go?</span>
              <input
                className="tg-textinput"
                value={destination}
                onChange={(e) => setDestination(e.currentTarget.value)}
                placeholder="e.g. Madina, Spintex, East Legon"
                aria-label="Destination"
              />
            </label>
            <label className="tg-field">
              <span>What happened?</span>
              <textarea
                className="tg-textinput"
                rows={4}
                value={detail}
                onChange={(e) => setDetail(e.currentTarget.value)}
                placeholder="e.g. searched &ldquo;Madina&rdquo; and got nothing"
                aria-label="What happened"
              />
            </label>
            <button className="tg-btn tg-btn--primary" disabled={busy || !destination.trim()} onClick={submit}>
              <Send size={20} strokeWidth={2} aria-hidden="true" />
              {busy ? 'Saving…' : 'Submit'}
            </button>
            <p className="tg-hint">We only store what you type here, never your location.</p>
          </section>
        )}
      </main>
    </div>
  );
}
