// At most one interrupting popup per visit, so a new rider never meets two in a row.
const KEY = 'trotro:popupShown';
let shownThisVisit = false;

export function claimPopup(): boolean {
  if (shownThisVisit) return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
  } catch {
    // storage blocked: the in-memory flag still limits this page load
  }
  shownThisVisit = true;
  return true;
}
