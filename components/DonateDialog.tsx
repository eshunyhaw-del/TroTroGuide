'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Heart, X, CheckCircle2 } from 'lucide-react';
import {
  DONATE_AMOUNTS_GHS,
  MIN_DONATION_GHS,
  PAYSTACK_PUBLIC_KEY,
  SUPPORT_ENABLED,
  onOpenDonate,
} from '@/lib/support';
import { payWithPaystack } from '@/lib/paystack';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = 'form' | 'paying' | 'thanks';

export function DonateDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [amount, setAmount] = useState<number>(DONATE_AMOUNTS_GHS[1]);
  const [custom, setCustom] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!SUPPORT_ENABLED) return;
    return onOpenDonate(() => {
      setPhase('form');
      setError(null);
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restore?.focus?.();
    };
  }, [open]);

  if (!SUPPORT_ENABLED || !open) return null;

  const finalAmount = custom.trim() ? Number(custom) : amount;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(finalAmount) || finalAmount < MIN_DONATION_GHS) {
      setError(`Enter an amount of at least GH₵${MIN_DONATION_GHS}.`);
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email so Paystack can send your receipt.');
      return;
    }
    setError(null);
    setPhase('paying');
    try {
      const result = await payWithPaystack({
        publicKey: PAYSTACK_PUBLIC_KEY,
        email: email.trim(),
        amountGhs: finalAmount,
      });
      setPhase(result.status === 'success' ? 'thanks' : 'form');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment could not start.');
      setPhase('form');
    }
  };

  return (
    <div className="tg-donate-scrim" onClick={() => phase !== 'paying' && setOpen(false)}>
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tg-give-title"
        className="tg-donate glass tg-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="tg-donate-x" onClick={() => setOpen(false)} aria-label="Close">
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>

        {phase === 'thanks' ? (
          <>
            <span className="tg-donate-heart" aria-hidden="true">
              <CheckCircle2 size={24} strokeWidth={2} />
            </span>
            <h2 id="tg-give-title" className="tg-donate-title">Thank you!</h2>
            <p className="tg-donate-body">
              Your gift keeps TroTro Guide free for every rider in Accra. A receipt is on its way to
              your email.
            </p>
            <div className="tg-donate-actions">
              <button className="tg-btn tg-btn--primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <span className="tg-donate-heart" aria-hidden="true">
              <Heart size={24} strokeWidth={2} />
            </span>
            <h2 id="tg-give-title" className="tg-donate-title">Support TroTro Guide</h2>
            <p className="tg-donate-body">
              Pay with Mobile Money or card through Paystack.
            </p>

            <div className="tg-give-amounts" role="radiogroup" aria-label="Amount">
              {DONATE_AMOUNTS_GHS.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={!custom && amount === a}
                  className={`tg-give-amount${!custom && amount === a ? ' is-on' : ''}`}
                  onClick={() => {
                    setAmount(a);
                    setCustom('');
                  }}
                >
                  GH₵{a}
                </button>
              ))}
            </div>

            <label className="tg-field">
              <span>Other amount (GH₵)</span>
              <input
                className="tg-textinput"
                type="number"
                inputMode="decimal"
                min={MIN_DONATION_GHS}
                placeholder="e.g. 15"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>

            <label className="tg-field">
              <span>Email for your receipt</span>
              <input
                className="tg-textinput"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            {error && (
              <p className="tg-give-error" role="alert">
                {error}
              </p>
            )}

            <div className="tg-donate-actions">
              <button className="tg-btn tg-btn--primary" type="submit" disabled={phase === 'paying'}>
                <Heart size={18} strokeWidth={2} aria-hidden="true" />
                {phase === 'paying'
                  ? 'Opening Paystack…'
                  : `Give GH₵${Number.isFinite(finalAmount) && finalAmount > 0 ? finalAmount : ''}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
