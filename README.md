# Eastern Lake: online pickup ordering

Customers order from their phone and pay with Stripe. The order then shows up on the kitchen tablet and prints on the kitchen printer.

```
Customer phone ──► your website ──► Stripe Checkout (card / Apple Pay / Google Pay)
                        │                      │
                        │◄──── payment confirmed (webhook)
                        ▼
              Android tablet in the kitchen (Chrome, /kitchen)
                        │  USB cable
                        ▼
                 PBM P-822D thermal printer
```

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Customers | Homepage: open/closed status, *Ordenar ahora* and *Ver menú* buttons, hours, phone numbers |
| `/menu` | Customers | Read-only menu with prices (sold-out items marked) |
| `/ordenar` | Customers | Menu, cart, pickup time (as soon as possible or a scheduled time today), name and phone, then Stripe payment |
| `/pedido.html?o=…` | Customers | Order number and live status (*Recibido → En cocina → Lista*), plus directions and a call button |
| `/kitchen/` | Staff (PIN) | Live orders, auto-print, *Lista ✓* / *Entregada ✓*, cancel and refund, pause online orders, mark items sold out, prep time |

Prices are always calculated on the server from `data/menu.json`, so nobody can change a price in their browser. IVU (7%) is added as its own line on the Stripe receipt. Order numbers use the format `MMDDYY-XX` (for example `092226-07`) and start over each day.

---

## 1. Try it on your computer (5 minutes)

You need Node.js 22.13 or newer (`node -v`).

```bash
cd eastern-lake
npm install
npm run dev
```

- Customer site: http://localhost:3000
- Kitchen: http://localhost:3000/kitchen/ (PIN **1234**)

`npm run dev` uses **mock payments**, which mark orders paid without charging anything, so you can click through the whole flow. Mock mode is automatically disabled in production.

If it's outside restaurant hours, the site correctly says *Cerrado*. To preview open hours, run it like this:
`DEV_NOW=2026-09-22T16:00:00Z npm run dev` (that's 12:00 PM in Puerto Rico).

To test with real Stripe test mode locally, copy `.env.example` to `.env`, fill in your `sk_test_…` key, and run `npm start`. To receive webhooks locally, use the Stripe CLI: `stripe listen --forward-to localhost:3000/webhook/stripe`. The order also confirms without a webhook, because the "thank you" page checks with Stripe directly.

---

## 2. Stripe setup

1. **API key:** Stripe Dashboard → Developers → API keys → copy the **Secret key**. Start with the test key (`sk_test_…`).
2. **Webhook:** Developers → Webhooks → *Add endpoint*
   - URL: `https://YOUR-DOMAIN/webhook/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - Copy the **Signing secret** (`whsec_…`).
3. **Apple Pay / Google Pay:** Settings → Payment methods. Make sure they're on (they show up automatically on Checkout).
4. **Receipts:** Settings → Customer emails → turn on *Successful payments*, so customers get an emailed receipt.
5. **Branding:** Settings → Branding. Upload `public/assets/icon-512.png` and set the colors to `#0e3b33` / `#b08d57` so Stripe's page matches the site.
6. **Test a payment** with card `4242 4242 4242 4242`, any future date, any CVC. When everything works, swap in the live keys and make a new live-mode webhook (it has a different signing secret).

---

## 3. Put it online (Render)

1. Put this folder in a GitHub repository (private is fine).
2. On https://render.com: **New → Blueprint** → pick the repo. Render reads `render.yaml`.
3. Fill in the environment variables it asks for:
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from step 2)
   - `KITCHEN_PIN`: pick a 4–8 digit PIN for the tablet
   - `PUBLIC_URL`: your site address, e.g. `https://ordenes.easternlakepr.com`
4. Optional: Settings → Custom Domains to use your own domain.

This uses Render's **Starter** plan (about $7/month) plus a 1 GB disk (about $0.25/month). The disk stores the orders database, so orders survive restarts. The free plan won't work, because it goes to sleep and erases its files.

**Backups:** the whole database is one file, `/var/data/orders.db`. Stripe keeps its own record of every payment too.

---

## 4. Kitchen tablet + printer

### Hardware
- The PBM P-822D has a **USB-B** port. The tablet has **USB-C**. Use a **USB-C (OTG) to USB-B printer cable**, or a USB-C adapter plus a normal printer cable.
- To **charge the tablet while the printer is plugged in**, use a small USB-C hub with **Power Delivery (PD) pass-through**: the charger goes into the hub, and the printer goes into a hub USB port.
- Load 80 mm paper and turn the printer on.

### One-time setup on the tablet
1. Open **Google Chrome** (it must be Chrome) and go to `https://YOUR-DOMAIN/kitchen/`.
2. Enter the PIN.
3. Chrome menu (⋮) → **Add to Home screen**. After that, open "Cocina" from the home screen and it runs full-screen.
4. Tap **Empezar turno**, then **Conectar impresora**. Pick the printer from the list and allow access when Android asks.
5. Tap ☰ → **Imprimir prueba**. If accented letters (á, ñ) come out as strange symbols, turn on **Sin acentos**.
6. Android settings to change once:
   - *Settings → Apps → Chrome → Battery → **Unrestricted*** (so Android doesn't put the kitchen page to sleep)
   - Turn media volume up. The new-order sound uses media volume.
   - The page keeps the screen on by itself while it's open. As a backup, set *Display → Screen timeout* to the maximum.

### Every day
Open **Cocina**, then tap **Empezar turno**. That's it. The tap is needed because Android only allows sound after someone touches the screen.

### How it behaves
- **New order:** chime, the card flashes, and the ticket prints automatically.
- **Printer unplugged or out of paper:** a red banner shows how many orders haven't printed, and the chime repeats every 20 s until someone taps *Visto* or the ticket prints. After reconnecting the printer, pending tickets print by themselves.
- **Tablet loses internet:** customers can still order and pay. Those orders print as soon as the tablet is back online, and the top bar says *Sin conexión* while it's down.
- **Lista ✓** moves the order to the "Listas" column, and the customer's page changes to *¡Tu orden está lista!*.
- **Entregada ✓** when the customer picks it up.
- **✕** cancels an order. You can refund the card automatically, or cancel without a refund.
- ☰ **Ajustes:** pause online orders, change prep time (it controls the "listo en ~20 min" estimate), mark dishes **sold out** for the day, number of ticket copies, and sound on/off.

### If USB printing doesn't work on your tablet
Chrome for Android talks to the printer directly over USB (WebUSB). Most ESC/POS printers work this way, but it hasn't been tested with your exact printer and tablet. If Chrome can't see the printer:
1. Try another cable, and make sure the printer's interface mode is set to USB (see the P-822D manual).
2. **Plan B:** install **RawBT** from the Play Store. It adds an Android print service for ESC/POS printers. The *Imprimir* button on each card falls back to the normal Android print dialog when no USB printer is connected, and RawBT can print from there.

---

## 5. Changing the menu, prices and hours

- **Menu and prices:** `data/menu.json`. Prices are in **cents** (`1295` = $12.95). Each item's `id` must stay unique. After a change, push to GitHub and Render redeploys automatically.
- **Combo options:** all 41 combo items share one set of questions, `optionSets.combo` at the top of `data/menu.json`:
  1. *Acompañante*: con arroz y papas, con arroz y tostones (+$2.50), con arroz sin papas, or solo
  2. *Tostones*: con ajo or sin ajo (only asked for tostones)
  3. *¿Extra ajo?*: no, gracias (default), extra ajo +$0.50, or extra ajo +$1.00 (only asked for con ajo)
  4. *Arroz*: arroz frito (default) or arroz blanco (skipped for solo)
  5. *Cambios al arroz frito*: sin/solo jamón, huevo, cerdo, vegetal; sin soya, sin sal, sin ajinomoto. More than one is allowed, but not "sin X" together with "solo X" (only asked for arroz frito).

  Each question only appears after the one before it is answered. To change a price, edit that choice's `"price"` (in cents). `showIf` controls when a question is asked. The same rules run in the browser and on the server (`public/options.js`).
- **Hours:** `data/config.json` → `hours` (0 = Sunday). Online orders stop 15 minutes before closing (`lastOrderMinutesBeforeClose`). Customers can also order before opening for a scheduled pickup later that day.
- **Tax:** `taxRate` and `taxLabel` in `data/config.json` (currently 0.07 / "IVU 7%").
- For a sold-out item or a busy night, use the kitchen screen. No code changes needed.

---

## 6. Files

```
server.js              Web server: menu, checkout, Stripe webhook, kitchen API
src/orders.js          Cart validation, pricing, IVU, order numbers
src/time.js            Puerto Rico hours, open/closed, pickup time slots
src/db.js              SQLite database (built into Node, nothing to install)
data/menu.json         The menu (89 items, 12 sections)
data/config.json       Hours, tax, prep time, address/phones
public/                Customer site (index.html, app.js, pedido.html, styles.css)
public/kitchen/        Kitchen tablet screen + printer driver (escpos.js)
render.yaml            Render deployment
```
