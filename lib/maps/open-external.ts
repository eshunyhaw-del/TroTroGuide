// Hand off to the phone's own maps app for turn-by-turn WALKING directions.

function isAppleDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Mac; the touch check disambiguates a real iPad.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Open external walking directions to (toLat,toLng). Apple Maps on Apple devices, Google Maps
 * everywhere else (opens the app if installed, else web).
 */
export function openWalkingDirections(toLat: number, toLng: number, toName?: string): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;

  // Coordinates alone are an unambiguous destination; the name is only used for the optional Google
  // "q" label so the pin reads sensibly if the app shows it.
  const dest = `${toLat},${toLng}`;
  const url = isAppleDevice()
    ? // Apple Maps: no saddr => current location
      `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=w` +
      (toName ? `&q=${encodeURIComponent(toName)}` : '')
    : // Google Maps: no origin => current location
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;

  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
