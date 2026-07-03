'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { Bus, Download, WifiOff, RefreshCw } from 'lucide-react';
import { usePack } from '@/lib/corepack/usePack';

const fmtMb = (bytes: number | null): string => (bytes ? (bytes / 1_000_000).toFixed(1) : '~1.2');


function GateBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="tg-gatewrap">
      <Image
        src="/img/tema-motor-way-trotro-one.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="tg-gatebg-img"
      />
      <div className="tg-gatebg-scrim" />
      {children}
    </div>
  );
}


export function CorePackGate({ children }: { children: ReactNode }) {
  const { state, sizeBytes, confirmDownload, retry } = usePack();

  if (state === 'ready') return <>{children}</>;

  if (state === 'needs-consent') {
    const mb = fmtMb(sizeBytes);
    return (
      <GateBackdrop>
        <section role="dialog" aria-label="Download map data" className="tg-card glass tg-rise">
          <h2 className="tg-h2">
            <Download size={22} strokeWidth={1.75} aria-hidden="true" />
            Download Accra map data?
          </h2>
          <p className="tg-body">
            About <strong>{mb} MB</strong>. After this, search and on-board directions work with no
            internet, useful when you&apos;re on the road with patchy signal.
          </p>
          <button onClick={confirmDownload} className="tg-btn tg-btn--primary">
            <Download size={20} strokeWidth={2} aria-hidden="true" />
            Download {mb} MB
          </button>
        </section>
      </GateBackdrop>
    );
  }

  if (state === 'downloading') {
    return (
      <GateBackdrop>
        <section className="tg-loading tg-loading--ongate" aria-busy="true" aria-live="polite">
          <Bus size={48} strokeWidth={1.25} className="tg-bounce" aria-hidden="true" />
          <p className="tg-caption">Downloading Accra routes…</p>
          <div className="tg-progressbar" role="progressbar" aria-label="Downloading map data" />
        </section>
      </GateBackdrop>
    );
  }

  if (state === 'error') {
    return (
      <GateBackdrop>
        <section className="tg-card glass tg-rise">
          <h2 className="tg-h2">
            <WifiOff size={22} strokeWidth={1.75} aria-hidden="true" />
            Can&apos;t load the map
          </h2>
          <p className="tg-body">You may be offline and have no saved copy yet.</p>
          <button onClick={retry} className="tg-btn tg-btn--primary">
            <RefreshCw size={20} strokeWidth={2} aria-hidden="true" />
            Retry
          </button>
        </section>
      </GateBackdrop>
    );
  }

  
  return (
    <GateBackdrop>
      <section className="tg-loading tg-loading--ongate" aria-busy="true" aria-live="polite">
        <Bus size={48} strokeWidth={1.25} className="tg-bounce" aria-hidden="true" />
        <p className="tg-caption">Loading Accra routes…</p>
      </section>
    </GateBackdrop>
  );
}
