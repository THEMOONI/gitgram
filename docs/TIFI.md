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

`WORLD_FEED_URL` är valfri och av som standard. Utan den används det inbyggda simulerade World-flödet, och testerna behöver inget nät. Sätts den ska den peka på en separat läsare på samma maskin, till exempel `WORLD_FEED_URL=http://127.0.0.1:8793`. Bara loopback (`localhost`, `127.0.0.1`, `::1`) accepteras. En annan adress ignoreras.

Den läsaren får bara lämna ut offentlig kedjedata: Solana-programkonton och Chainlink-priser. TIFI hämtar inte World-data via PayBox, vare sig SDK, MCP eller API, och anropar inte World direkt. En odokumenterad proxy, eller något som går runt Cloudflare eller en hastighetsgräns, får inte användas. Gitgram har ingen sådan adress inlagd.

`WORLD_FEE_COEF` (standard 800) ger avgiften `800×(1−p)` bps per avslut, där `p` är priset 0–1. Det är en obekräftad tredjepartsuppskattning, inte en bekräftad World-avgift. Det finns ingen minsta order. `WORLD_CLOSE_BUFFER_SEC` (standard 60) är sekunderna före stängning då ingen ny pappersorder läggs. Ingen hävstång på prediktionsmarknader.

Serierna är `WXBTC15M`, `WXETH15M` och `WXSOL15M`. Namnen kan bytas med `WORLD_SERIES_BTC`, `WORLD_SERIES_ETH` och `WORLD_SERIES_SOL`. TIFI 1 följer BTC, TIFI 2 ETH och TIFI 3 SOL.

Servern binds som tidigare. Demon körs med `HOST=127.0.0.1` och `PORT=8792`.

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

## World-marknader (papper)

TIFI 1–3 kan, på papper, köpa YES- eller NO-andelar. YES är upp och NO är ned. TIFI 1 använder `WXBTC15M`, TIFI 2 `WXETH15M` och TIFI 3 `WXSOL15M`. Signalen är tigerns vanliga utbrott, trend eller momentum på den underliggande kursen. Förslaget loggas innan en pappersorder bokförs. En vinnande andel löses till 1 DEMO, vilket motsvarar kontraktets 1 USD, och en förlorande andel till 0. Det är inte dollar. Kassans fördelning mellan tigrarna ändras inte.

Avsnittet på tavlan heter `World-marknader (papper, endast eget bruk, simulerat/kedjedata)`. Det visas bara för den inloggade ägaren. Ingen export, ingen delning och ingen offentlig visning. När källan är `simulated` står `simulerat` tydligt i avsnittet. Annars märks en lokal läsare `Kedjedata från lokal läsare · papper, endast eget bruk`.

En läsare på `http://127.0.0.1:8793` kan senare lämna samma fält: `ticker`, `seriesTicker`, `openTime`, `closeTime`, `status` (`initialized`, `active`, `finalized`), `result` (`yes` eller `no`), `yesBid`, `yesAsk`, `noBid`, `noAsk`, samt valfria `source` och `fetchedAt`. Konton i `accounts` ignoreras. Adaptorn tål också en äldre lista med `outcomes`.

Ägaren kan per tiger, med ägarlösenord, välja den befintliga pappersmarknaden i stället. Standard är World-marknader mot det simulerade flödet, eller mot `WORLD_FEED_URL` när den är satt.

Riktiga pengar mot World eller PayBox är inte tillåtna. Juridisk granskning har sagt nej. Anropet är låst och skickar ingen order.
