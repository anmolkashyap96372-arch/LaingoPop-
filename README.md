# LaingoPop device reminder server

This optional server adds real Web Push delivery so a user can receive LaingoPop reminders after the app is backgrounded/closed, where the browser/OS permits it.

## Run

```bash
cd server
npm install
npm start
```

Open `http://localhost:8787` on the phone (for LAN testing, bind/use a reachable HTTPS host; production Web Push requires HTTPS except localhost). The server creates VAPID keys in `server/data/vapid.json` and subscriptions in `server/data/subscriptions.json`.

Set `VAPID_SUBJECT` to a real contact address before production, e.g. `VAPID_SUBJECT=mailto:you@example.com`.

## Important platform limits

- Web Push can deliver the notification while LaingoPop is not visible, but the webpage cannot force a custom alarm sound when it is completely closed. The phone/browser controls notification-channel sound; vibration is requested by the service worker.
- Exact background alarm timing is browser/OS dependent. The server checks every 15 seconds and sends a push when a scheduled minute is due.
- For iPhone, install the PWA to the Home Screen and enable notifications; support depends on the current iOS/Safari rules.
- This prototype's local Laingo CC accounts are not server-authenticated. Before public launch, protect `/subscribe`, `/unsubscribe` and `/test` with real account authentication and HTTPS.

## AI translation (optional)

The app now posts translations to `/api/translate` first. For higher-quality context-aware translation, set these environment variables on the server:

- `OPENAI_API_KEY` — server-side API key; never put this in the browser/app HTML.
- `ANTHROPIC_API_KEY` — (recommended) Claude-powered context-aware translation; optional `ANTHROPIC_TRANSLATION_MODEL` (default `claude-sonnet-5`). Tried first, then OpenAI, then public MT.
- `OPENAI_TRANSLATION_MODEL` — optional model override; defaults to `gpt-5.6-luna`.

Without the key, `/api/translate` falls back to the public machine-translation providers and the browser also keeps its existing fallback path. Results are cached on the server and in the browser for repeated vocabulary lookups.

No translation system can truthfully guarantee 100% accuracy for every possible word and context, so the UI describes the feature as high-confidence translation rather than a mathematically guaranteed result.

## Payments (Stripe Checkout)

Plans: 7-day pass $1.99 (one-time), Monthly $3.99, Yearly $29.99 (37% off vs 12 months). Set these env vars on the server host:

- `STRIPE_SECRET_KEY` - your Stripe secret key (never put it in the HTML)
- `STRIPE_WEBHOOK_SECRET` - signing secret of a webhook pointing to `https://YOUR-DOMAIN/api/pay/webhook`
- `PUBLIC_URL` - your site URL, e.g. `https://laingopop.example.com`

Webhook events to enable: `checkout.session.completed`, `invoice.paid`. Pro is granted only after the signed webhook arrives; the app polls `/api/pay/status`.
Turn on the payment methods you want (cards, Google Pay/Apple Pay, UPI/netbanking where available) in the Stripe Dashboard. In `index.html` set `LP_TEST_MODE=false` (search for it) before launch so nobody can simulate a purchase.
Limits: entitlements are tied to a per-device id (no accounts yet), and the file store is a prototype, use a database for production.
