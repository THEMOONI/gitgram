# TIFI (Tiger Finance)

Pappershandel med tre AI-tigrar. Inga riktiga pengar. Inga börsnycklar.

## Starta

```bash
npm install
npm run tifi:demo
HOST=127.0.0.1 PORT=8792 npm start
```

Öppna `http://127.0.0.1:8792/login`. Kräver Node 22.

- Användare: `tifi`
- Lösenord: `tifi-demo`
- Ägarlösenord (minst 12 tecken): `tigerpapper-2026`

Designfiler ligger i `design/tifi/` och kan bytas ut mot en senare leverans med samma filnamn. Appen läser kopian i `public/tifi/` (`tokens.css`, `tifi-components.css`, `brand/`, `portraits/`). Porträttet är platshållaren tills det genereras. Mascoten som visas är `tifi-mascot-clean.png`.

Inga miljövariabler krävs. Utan `COINGECKO_API_KEY` används den påhittade prisserien. Utan `OPENAI_API_KEY` används den lokala modellen. `TIFI_IMAGE_API_KEY` är valfri och av som standard. Utan den, och utan `TIFI_IMAGE_API_URL`, stannar porträtten på de lokala filerna. Adaptorn anropar inte nätet.

`npm test` ska gå utan nycklar.

## Återställ

Radera SQLite-filen och kör demon igen:

```bash
rm -f db/gitgram.db db/gitgram.db-shm db/gitgram.db-wal
npm run tifi:demo
```

## Tavla

`/tifi` visar kassan, TIFI 1–3, beslut och en intern topplista i procent. `/bots` pekar om till `/tifi` och kräver samma inloggning. `/tifi/setup` är installningen för ett nytt konto. `/tifi/tigers` skapar en tiger från en mening.

Hävstång lagras med tak 2× men körs på 1×. Pappersboken har ingen marginal. `marginMultiplier()` i `lib/tifi/guard.ts` är utbyggnadspunkten.
