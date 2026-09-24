const SCRIPT_SRC = 'https://js.paystack.co/v2/inline.js';

interface PaystackTransaction {
  reference: string;
  status?: string;
}

interface PaystackPopInstance {
  newTransaction(options: {
    key: string;
    email: string;
    amount: number;
    currency: string;
    metadata?: Record<string, unknown>;
    onSuccess: (tx: PaystackTransaction) => void;
    onCancel: () => void;
    onError?: (err: { message?: string }) => void;
  }): void;
}

declare global {
  interface Window {
    PaystackPop?: new () => PaystackPopInstance;
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.PaystackPop) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('Could not load Paystack. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export type PaystackResult = { status: 'success'; reference: string } | { status: 'cancelled' };

export async function payWithPaystack(opts: {
  publicKey: string;
  email: string;
  amountGhs: number;
}): Promise<PaystackResult> {
  await loadScript();
  const Pop = window.PaystackPop;
  if (!Pop) throw new Error('Paystack is unavailable right now.');

  return new Promise((resolve, reject) => {
    new Pop().newTransaction({
      key: opts.publicKey,
      email: opts.email,
      amount: Math.round(opts.amountGhs * 100), // pesewas
      currency: 'GHS',
      metadata: { purpose: 'donation' },
      onSuccess: (tx) => resolve({ status: 'success', reference: tx.reference }),
      onCancel: () => resolve({ status: 'cancelled' }),
      onError: (err) => reject(new Error(err?.message || 'Payment could not start.')),
    });
  });
}
