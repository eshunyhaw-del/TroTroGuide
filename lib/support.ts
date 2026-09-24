// Public key only (pk_...). It ships to the browser; a secret key (sk_...) must never go here.
export const PAYSTACK_PUBLIC_KEY = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY ?? '';

export const SUPPORT_ENABLED = PAYSTACK_PUBLIC_KEY.startsWith('pk_');

export const DONATE_AMOUNTS_GHS = [10, 20, 50, 100] as const;
export const MIN_DONATION_GHS = 1;

const OPEN_EVENT = 'trotro:donate';

export function openDonate() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenDonate(handler: () => void) {
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}
