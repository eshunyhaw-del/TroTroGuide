import Image from 'next/image';
import { AppMenu } from '@/components/AppMenu';
import { CorePackGate } from '@/components/CorePackGate';
import { HomeLogo } from '@/components/HomeLogo';
import { Trotro } from '@/components/Trotro';

export default function Home() {
  return (
    <div className="tg-app">
      <header className="tg-header glass glass--blur">
        <div className="tg-header-in tg-topbar">
          <HomeLogo>
            <span className="tg-brand-logo-wrap">
              <Image src="/img/trotro-logo.png" alt="" width={75} height={75} className="tg-brand-logo" priority />
            </span>
            <span className="tg-brand-name">TroTro<span className="tg-brand-accent">Guide</span></span>
          </HomeLogo>
          <AppMenu />
        </div>
      </header>
      <main className="tg-main">
        <CorePackGate>
          <Trotro />
        </CorePackGate>
      </main>
    </div>
  );
}
