'use client';

import type { ReactNode } from 'react';


export function HomeLogo({ children }: { children: ReactNode }) {
  return (
    <a
      className="tg-brand"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(new Event('trotro:gohome'));
      }}
    >
      {children}
    </a>
  );
}
