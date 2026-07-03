// Structured logging (pino). Configured to REDACT location fields so a stray
// log call can never leak raw GPS (reinforces correction #1). Only ever log the
// coarse H3 cell, never lat/lng.
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Defence in depth: if any of these keys ever appear in a log object, censor
  // them. The app is written never to log coordinates in the first place.
  redact: {
    paths: ['lat', 'lng', 'latitude', 'longitude', '*.lat', '*.lng', 'gps', '*.gps', 'headers.authorization'],
    censor: '[redacted]',
  },
});
