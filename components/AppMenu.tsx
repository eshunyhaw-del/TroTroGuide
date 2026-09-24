'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Menu, Home, Flag, Info, Heart } from 'lucide-react';
import { SUPPORT_ENABLED, openDonate } from '@/lib/support';

export function AppMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  
  const goHome = () => {
    setOpen(false);
    window.dispatchEvent(new Event('trotro:gohome'));
    router.push('/');
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="tg-menuwrap" ref={ref}>
      <button
        className="tg-menubtn"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <nav className="tg-menusheet glass" role="menu">
          <button className="tg-menuitem" role="menuitem" onClick={goHome}>
            <Home size={18} strokeWidth={1.75} aria-hidden="true" />
            Home
          </button>
          <Link className="tg-menuitem" role="menuitem" href="/contribute" onClick={() => setOpen(false)}>
            <Flag size={18} strokeWidth={1.75} aria-hidden="true" />
            Help us map it
          </Link>
          {SUPPORT_ENABLED && (
            <button
              className="tg-menuitem"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openDonate();
              }}
            >
              <Heart size={18} strokeWidth={1.75} aria-hidden="true" />
              Support this project
            </button>
          )}
          <div className="tg-menudivider" />
          <p className="tg-menufoot">
            <Info size={12} strokeWidth={2} aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }} />
            TroTro Guide · Accra
          </p>
        </nav>
      )}
    </div>
  );
}
