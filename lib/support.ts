// Single source of truth for the donation link.
//
// Paste your Paystack PAYMENT PAGE url below, e.g.
//   export const SUPPORT_URL = 'https://paystack.com/pay/trotroguide';
// A Paystack payment page supports Mobile Money + Visa/Mastercard automatically
// and needs NO secret key in the app. While this is '', every donate control
// (home card, result-screen link, menu item) renders nothing.
//
// SECURITY: only ever put a PUBLIC payment-page URL here — NEVER a secret key
// (sk_...). This file ships to the browser.
export const SUPPORT_URL = 'https://paystack.shop/pay/trotro-guide';

export const SUPPORT_ENABLED = SUPPORT_URL.trim().length > 0;
