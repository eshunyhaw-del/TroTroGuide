// Forwards "missing route" demand signals to a Google Sheet via an Apps Script webhook, so the
// operator sees what riders asked for and can prioritise fieldwork.

const FORWARD_TIMEOUT_MS = 5000;

export function sheetsConfigured(): boolean {
  return Boolean(process.env.SHEETS_WEBHOOK_URL && process.env.SHEETS_WEBHOOK_SECRET);
}

/** POST one missing-route report to the sheet. Returns true only on a confirmed {ok:true}. */
export async function forwardMapRequest(destination: string, detail: string): Promise<boolean> {
  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  if (!url || !secret) return false;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FORWARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, destination, detail }),
      signal: ac.signal,
      // Apps Script 302-redirects to its content host; fetch follows it and the doPost side-effect
      // (the row append) has already run by then.
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(body?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
