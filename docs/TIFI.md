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

`TIFI_MARKET_LABELS` är tom som standard, och då visas de interna namnen. `TIFI_MARKET_LABELS=neutral` byter visningsnamnen till `SIM-BTC-15M`, `SIM-ETH-15M` och `SIM-SOL-15M` och döljer ordet World i gränssnittet. Källmärkningen `simulerat`, ansvarsfriskrivningen och låset mot riktiga pengar är oförändrade.

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

TIFI 1, TIFI 2 och TIFI 3 är AI-agenter som agerar för Scavvers Labs räkning. Första beslutet i varje session börjar med den meningen, tillagd på servern efter att svaret faktiskt skickats. Avbryts svaret innan dess sägs meningen igen nästa gång. Varje beslutskort, och sessionstarten på `/bots` (via `/tifi`) och `/tifi/tigers`, visar texten `AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning`. Den sitter i sidan, inte i en tooltip. Frågar man om agenten är en människa svarar den att den är en AI. TIFI har ingen röstväg: ingen taligenkänning, ingen talsyntes, ingen röstidentifiering och ingen kloning. Kryssrutan för röstinspelning sparar bara ett sessionsval och spelar inte in ljud.

Hävstång över 1× avvisas. Effektiv hävstång på papper är 1×. Pappersboken har ingen marginal, och `marginMultiplier()` i `lib/tifi/guard.ts` stannar på 1.

Varje position är högst 10 % av lek-kassan (portföljvärdet). En tiger får ha högst 3 öppna innehav. Vid 20 % värdeminskning från topp-equity pausar kill switchen nya öppningar tills ägaren återställer portföljen.

```bash
npm run tifi:backtest -- --symbols=BTC,ETH,SOL --days=90
```

Kommandot kör TIFI 1, TIFI 2 och TIFI 3 mot den påhittade prisserien, utan API-nyckel. Standard är BTC, ETH och SOL och ungefär 90 dagars staplar. Utskriften är simulerad avkastning, max drawdown och antal affärer per tiger. Det är en pappersreplay, inte en prognos.

## World-marknader (papper)

TIFI 1–3 kan, på papper, köpa YES- eller NO-andelar. YES är upp och NO är ned. TIFI 1 använder `WXBTC15M`, TIFI 2 `WXETH15M` och TIFI 3 `WXSOL15M`. Signalen är tigerns vanliga utbrott, trend eller momentum på den underliggande kursen. Förslaget loggas innan en pappersorder bokförs. En vinnande andel löses till 1 DEMO, vilket motsvarar kontraktets 1 USD, och en förlorande andel till 0. Det är inte dollar. Kassans fördelning mellan tigrarna ändras inte.

Avsnittet på tavlan heter `World-marknader (papper, endast eget bruk, simulerat/kedjedata)`, om inte `TIFI_MARKET_LABELS=neutral` är satt. Det visas bara för den inloggade ägaren. Ingen export, ingen delning och ingen offentlig visning. När källan är `simulated` står `simulerat` tydligt i avsnittet. Annars märks en lokal läsare `Kedjedata från lokal läsare · papper, endast eget bruk`.

Det här är internt bruk på localhost. All extern visning, till exempel en demo, en pitch, skärmdumpar eller andra användare, kräver en ny juridisk granskning först. Den visningen ska använda `TIFI_MARKET_LABELS=neutral` och får inte kopplas till, eller antyda ett partnerskap med, World.

Rå spot- och marknadsprishistorik sparas inte som en permanent prisdatabas. Varje pollad ögonblicksbild skrivs inte till en tabell, så det finns ingen kvotlogg att beskära. Pappersboken behåller priset vid avslut och avräkning (`tifi_world_fills.price_micro`), positionen, avräkningsutfallet och ett aktuellt mittpris (`tifi_world_positions.last_mid_micro`) som skrivs över. Beslutsloggen sparar förslaget, inte en prisserie. Om en poll-logg läggs till senare ska den bara behålla de senaste 24 timmarna. Pappersmotorns krypterade priscache gäller redan högst 24 timmar och är inte en historik. `paper_equity_snapshots` är motorns equity-kurva, kassa och eget kapital, inte råa spotkurser.

En läsare på `http://127.0.0.1:8793` kan senare lämna samma fält: `ticker`, `seriesTicker`, `openTime`, `closeTime`, `status` (`initialized`, `active`, `finalized`), `result` (`yes` eller `no`), `yesBid`, `yesAsk`, `noBid`, `noAsk`, samt valfria `source` och `fetchedAt`. Konton i `accounts` ignoreras. Adaptorn tål också en äldre lista med `outcomes`.

Ägaren kan per tiger, med ägarlösenord, välja den befintliga pappersmarknaden i stället. Standard är World-marknader mot det simulerade flödet, eller mot `WORLD_FEED_URL` när den är satt.

Riktiga pengar mot World eller PayBox är inte tillåtna. Juridisk granskning har sagt nej. Anropet är låst och skickar ingen order.
