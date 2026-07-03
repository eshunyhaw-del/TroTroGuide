// Hand off to the phone's own maps app for turn-by-turn WALKING directions.
//
// Privacy: we pass ONLY the destination (a public bus-stop coordinate) and let
// the device fill in "My Location" as the origin. The user's GPS coordinates
// never go into a URL/query string. Needs internet — this is the one online
// touch in an otherwise offline app, so callers should gate it on connectivity.

function isAppleDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Mac; the touch check disambiguates a real iPad.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Open external walking directions to (toLat,toLng). Apple Maps on Apple
 * devices, Google Maps everywhere else (opens the app if installed, else web).
 *
 * Returns true if we had a real window to attempt the open in, false on SSR.
 * NOTE: actual open success is NOT detectable here — with `noopener` set,
 * window.open() returns null even on a successful open (by spec), and we keep
 * noopener for security rather than weaken it to recover a handle.
 */
export function openWalkingDirections(toLat: number, toLng: number, toName?: string): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;

  // Coordinates alone are an unambiguous destination; the name is only used for
  // the optional Google "q" label so the pin reads sensibly if the app shows it.
  const dest = `${toLat},${toLng}`;
  const url = isAppleDevice()
    ? // Apple Maps: no saddr => current location; dirflg=w => walking.
      `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=w` +
      (toName ? `&q=${encodeURIComponent(toName)}` : '')
    : // Google Maps: no origin => current location; travelmode=walking.
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;

  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
