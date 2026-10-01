# TIFI (Tiger Finance): design handoff

TIFI is a **paper-trading-only** AI trading demo inside Gitgram. Three AI tigers named **TIFI 1**, **TIFI 2** and **TIFI 3** trade with simulated money. Nothing has real value, and nothing promises returns.
Design system: Gitgram "Terminal Volt" reskinned in black and orange with a tiger mascot. All UI copy is in Swedish.

## File list (stable names, drop-in)

| File | Purpose |
|---|---|
| `tokens.css` | All tokens as `--tifi-*` custom properties, scoped to `.tifi, [data-app="tifi"]`. No `:root`, no element resets. |
| `tokens.json` | The same tokens as JSON, with contrast notes. |
| `tifi-components.css` | Component classes (`.tifi-*`), all scoped under `.tifi`. Requires `tokens.css`. |
| `dashboard.html` → `dashboard-1440.png`, `dashboard-390-mobile.png` | Dashboard |
| `setup-1-risk.html` → `setup-1-risk-1440.png`, `setup-1-risk-390-mobile.png` | Setup 1: risk acknowledgement |
| `setup-2-losenord.html` → `setup-2-losenord-1440.png`, `setup-2-losenord-390-mobile.png` | Setup 2: owner password |
| `setup-3-tigrar.html` → `setup-3-tigrar-1440.png`, `setup-3-tigrar-390-mobile.png` | Setup 3: "Designa dina tigrar" (done / created / empty states) |
| `components.html` → `components.png` | Component sheet |
| `portraits/tifi-1.png`, `tifi-2.png`, `tifi-3.png` | Portraits, 1024×1024 PNG |
| `portraits/tifi-1-256.png` … `tifi-3-256.png` | Portraits, 256×256 |
| `portraits/tifi-placeholder.png`, `tifi-placeholder-256.png` | Neutral graphite placeholder tiger, shown before a portrait is generated |
| `brand/tifi-logo.svg`, `brand/tifi-logo.png` | Logo: geometric tiger head plus a TIFI wordmark drawn as paths (no font needed). PNG is 784×256 with transparent background. |
| `brand/tifi-mascot-clean.png` | The mascot with the "INFY" sleeve patch removed (inpainted). 914×1160 RGBA. |
| `build/` | Mockup generator scripts (`gen_*.py`), renderers (`render1440.sh` uses google-chrome headless; `render390.js` uses playwright-core with the same Chrome), and the original portrait JPGs. Not needed at runtime. |

## How to use the tokens

```html
<link rel="stylesheet" href="/tifi/tokens.css">
<link rel="stylesheet" href="/tifi/tifi-components.css">
<main class="tifi" data-app="tifi">
  <div class="tifi-sim-banner" role="status">
    <span class="tifi-sim-banner__stripes" aria-hidden="true"></span>
    <span class="tifi-paper">Paper trading</span>
    <span class="tifi-sim-banner__text"><b>SIMULERING</b> · Simulering – DEMO har inget värde</span>
    <span class="tifi-sim-banner__meta">Simulerade pengar · inga riktiga order · inte finansiell rådgivning</span>
  </div>
  …
</main>
```

- **Scoping.** Everything lives under `.tifi` / `[data-app="tifi"]`, so the rest of Gitgram is unaffected.
- **Fonts (Google Fonts, same as Gitgram).** Space Grotesk 500–700 for headings, Inter 400–700 for UI, JetBrains Mono 400–700 for numbers and labels.
- **Per-tiger accent.** Set `style="--acc: var(--tifi-t1)"` (or `t2`, `t3`) on a card. It drives the top border, chart, probability bars and leaderboard bar.
- **Number format.** Use `.tifi-mono` (tabular-nums) and Swedish formatting: `1 000,02`, `0,22 / 1,00`, `86 %`.

Contrast below is measured against `--tifi-bg-2`.

| Token | Value | Note |
|---|---|---|
| `--tifi-bg-0…3` | `#07080A` `#0E0F12` `#15171B` `#1D2026` | black → graphite |
| `--tifi-line`, `--tifi-line-2` | `#2A2D34`, `#393D46` | borders |
| `--tifi-text-1/2/3` | `#F3F1EE` `#B9B4AC` `#948F87` | 15.9 / 8.7 / 5.6:1, all AA |
| `--tifi-orange` | `#FF7A1A` | primary. Hover `#FF8F3D`, pressed `#E8590C` |
| `--tifi-on-orange` | `#0B0B0C` | text on orange, 7.5:1. **Never white on orange (2.6:1, fails AA).** |
| `--tifi-orange-text` | `#FF9A4D` | orange as text, 8.5:1 |
| `--tifi-up` / `--tifi-down` | `#3DDC97` / `#FF5D7A` | 10.2 / 6.1:1 |
| `--tifi-ai` | `#9A8CFF` | AI marker (Gitgram iris), 6.5:1 |
| `--tifi-t1/t2/t3` | `#FF7A1A` `#FFB547` `#EDE6DA` | TIFI 1 Utbrott · TIFI 2 Trend · TIFI 3 Momentum |
| `--tifi-glow-sm/md/lg`, `--tifi-shadow-card` | orange glows | |
| `--tifi-focus-ring` | `0 0 0 2px #07080A, 0 0 0 4px #FF9A4D` | used on all focusable elements |

Spacing is `--tifi-space-1…10` on a 4px grid. Radii are `--tifi-radius-sm` 6, `--tifi-radius` 10, `-lg` 14, `-xl` 20, `-pill` 999px.

## Components (spec)

- **Simulation banner** (`.tifi-sim-banner`)
  - Mandatory on **every** TIFI screen: dashboard, setup, wallet and trading.
  - Sticky, cannot be closed, `role="status"`.
  - Contains orange stripes, the PAPER TRADING label and the exact text "Simulering – DEMO har inget värde".
  - Below 600px it splits into two lines.
- **PAPER TRADING / DEMO label** (`.tifi-paper`, `--outline`)
  - Black text on orange, mono, uppercase.
  - Appears in the banner and next to the logo.
- **AI badge** (`.tifi-badge-ai`)
  - Iris pill with a chip icon.
  - Text: "AI-tiger" on TIFI tigers; "AI-agent" on the generic component (Gitgram /team, voice notice).
  - `title="Den här tigern är en AI-agent"`. Never hide it.
- **Voice notice** (`.tifi-voice`)
  - Shown **before** the microphone or call starts, every time.
  - Content: "Du pratar med en AI-agent", a short explanation, the AI-agent badge and the voice-recording status.
  - Buttons: "Starta samtal" (primary), "Avbryt", "Ändra röstsamtycke".
- **Consent dialog** (`.tifi-consent`)
  - "Avvisa" and "Godkänn" both use `.tifi-btn--choice`: same size, color and weight. Neither is preselected.
  - Nödvändiga: always on, shown as text.
  - Analys: off by default.
  - **Röstinspelning:** its own toggle, off by default. Godkänn never turns it on.
  - Closing the dialog counts as Avvisa. Choices can be changed under Inställningar.
- **Buttons** (`.tifi-btn` with `--primary`, `--secondary`, `--ghost`, `--choice`, `--lg`, `--block`)
  - Height 40px, or 48px with `--lg`.
  - `:disabled` is graphite.
  - Focus via `:focus-visible`. The `.is-hover` and `.is-focus` classes are only for the mockups.
- **Fields** (`.tifi-field`, `.tifi-label`, `.tifi-input`, `.tifi-textarea`, `.tifi-hint`, with `--error` / `--ok`)
  - Each `<label for>` matches an `id`. Hints are linked with `aria-describedby`.
  - Errors set `aria-invalid="true"` and show a red border.
  - Focus shows an orange border with glow.
- **Checkbox row** (`.tifi-check`): the whole row is the label. Checked state shows an orange tint.
- **Toggle** (`.tifi-toggle`): `input[type=checkbox][role=switch]`.
- **Tiger card**
  - Header: portrait (58px, accent ring), name, AI-tiger badge, tagline, rank.
  - Strategy row: Strategi · coin chip · perp (sim).
  - Saldo in DEMO.
  - Position box: side, symbol, value, unrealized; Entry / Mark / Stop. FLAT state shows "–" for each.
  - Simulated equity chart.
  - "Senaste beslut" with probability bars.
  - "Trades idag" and "Avgiftsbudget".
  - Footer: Avgifter / Funding / Modell / Anrop.
- **Right column:** Topplista, Live-beslutsflöde (fades out at the bottom), and Marknadskassa & fördelning (total, stacked bar, Tilldelat and I position / fritt per tiger).
- **Setup**
  - Stepper: Reglerna → Lösenord → Dina tigrar → Start.
  - A paper-trading note in every step. No hosting advertising.
  - Step 3 column states:
    - *done:* portrait, "Skapa igen", "Generera porträtt igen".
    - *created:* placeholder, results, primary "Generera porträtt".
    - *empty:* placeholder, empty prompt, "Skapa".
  - Names are fixed: TIFI 1/2/3.

## Copy strings (Swedish)

| Key | Text |
|---|---|
| banner.text | Simulering – DEMO har inget värde |
| banner.meta | Simulerade pengar · inga riktiga order · inte finansiell rådgivning |
| label.paper / paperDemo | PAPER TRADING / PAPER TRADING · DEMO |
| badge.aiTiger / aiAgent / title | AI-tiger / AI-agent / Den här tigern är en AI-agent |
| stats | Totalt P&L · Avgifter · Funding · Modellkostnad · Antal beslut |
| status | Avstämning · pappershandel: simulerade böcker · live |
| card | Strategi · Senaste beslut · Trades idag · Avgiftsbudget · Avgifter · Funding · Modell · Anrop · Entry · Mark · Stop · FLAT · LÅNG · orealiserat · leder · x efter |
| actions | BEHÅLL · STÄNG · BLANKA · AVVAKTA · RID |
| panels | Topplista · Live-beslutsflöde · Marknadskassa & fördelning · Tilldelat · I position / fritt |
| pool.footnote | Exempeldata. Kassan delas lika mellan tigrarna vid start. Alla belopp är DEMO och har inget värde. |
| setup.steps | Reglerna · Lösenord · Dina tigrar · Start |
| setup.note | Pappershandel. Tigrarna handlar med simulerade pengar mot riktiga marknadspriser. Simulering – DEMO har inget värde, och inga order skickas till en börs. |
| setup1.title / lead | Innan vi börjar / TIFI är ett experiment och öppen källkod, inte en handelsprodukt. Kryssa i alla tre för att fortsätta. |
| setup1.c1 | **Det här är inte finansiell rådgivning.** Inget som tigrarna gör, och inget i koden eller i demon, är en rekommendation att köpa eller sälja något. |
| setup1.c2 | **Mina tigrar handlar bara på papper.** De använder riktiga marknadspriser och simulerade pengar. DEMO har inget värde och kan inte tas ut eller växlas. |
| setup1.c3 | **Jag använder det på egen risk.** Programvaran levereras utan garanti (MIT-licens). Resultat i simuleringen säger ingenting om framtida resultat. |
| setup1.cta / hint | Jag godkänner / 2 av 3 ikryssade. Kryssa i alla för att fortsätta. |
| setup2 | Välj ett ägarlösenord · Lösenord · Upprepa lösenord · Starkt nog · ✓ Lösenorden matchar · ⚠ Minst 12 tecken. |
| nav | Tillbaka · Nästa |
| setup3 | Designa dina tigrar · Hur ska den här tigern handla? · Skapa · Skapa igen · Generera porträtt · Generera porträtt igen |
| setup3.placeholder | t.ex. en snabb tiger som rider på momentum i SOL och kliver av när farten dör |
| setup3.footer | Skapa alla tre tigrar och generera deras porträtt för att fortsätta. |
| voice | Du pratar med en AI-agent · Rösten du hör är TIFI 1, en AI-tiger och inte en människa. Den ger inga råd om riktiga pengar. Samtalet spelas bara in om du har slagit på röstinspelning. · Starta samtal · Avbryt · Ändra röstsamtycke |
| consent | Cookies och röst · Vi använder nödvändiga cookies för att TIFI ska fungera. Med ditt samtycke mäter vi också hur demon används. Röstinspelning frågar vi om separat. · Nödvändiga (Alltid på) · Analys · Röstinspelning · Avvisa · Godkänn · Spara mina val · Läs mer om data och röst |
| footer | Inte finansiell rådgivning. Pappershandel med simulerade pengar. Öppen källkod, MIT-licens, ingen garanti. |

## Compliance notes (from Gitgram-juridik)

1. **Permanent banner.** "Simulering – DEMO har inget värde" plus PAPER TRADING appear on every TIFI screen, including wallet and trading views.
   - Amounts use the unit **DEMO** and carry a "(sim)" marking.
   - No currency symbols on balances. The only exception is model cost, shown in USD and marked "exempel".
2. **No promises of returns.**
   - Example data uses tiny values.
   - Charts are labeled "simulerad".
   - Do not use words like "avkastning" or "tjäna" in marketing.
3. **AI transparency.**
   - Tigers show the "AI-tiger" badge; AI agents on /team show "AI-agent".
   - The voice notice "Du pratar med en AI-agent" appears before every voice call.
4. **Consent.**
   - Godkänn and Avvisa have equal weight.
   - Voice recording has its own toggle, off by default.
   - Nothing is preselected; closing the dialog counts as Avvisa.
   - Withdrawing consent must be as easy as giving it.
5. **Not financial advice.** Stated in setup (checkbox 1) and in the footer of every view.
6. **Licences and branding.**
   - The reference screenshots were used **for structure only**. No art, names or text were copied, and no hosting advertising is included.
   - Use only `brand/tifi-mascot-clean.png`, which has the "INFY" patch (Infosys' ticker) removed.

## Portraits: how they were made

The portraits were generated with Canva's image generation from text prompts only, in the mascot's style: black techwear, orange LED glow, glasses or visor.

- **TIFI 1:** beanie, visor goggles, raised fist, lightning-bolt clip.
- **TIFI 2:** hood, headphones, orange visor, arms crossed.
- **TIFI 3:** backwards cap, glowing wrist device, running.

The mascot could not be used as an image reference: uploading the local file to Canva was blocked by the safety check. So the portraits share the mascot's style but are not exactly the same character, and TIFI 2 looks somewhat more realistic.

If the exact character is required, regenerate with `brand/tifi-mascot-clean.png` as the reference once the upload is approved, and keep the file names.

All three were checked: they show tigers and contain no text or watermarks.
