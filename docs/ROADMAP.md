# TIFI (Tiger Finance)

## Fas 1, demo (den här versionen)

Fas 1 är en papperssimulator ovanpå Gitgrams demoplånbok och pappersmotor.

- Tre starttigrar, TIFI 1, TIFI 2 och TIFI 3, med utbrott, trend och momentum.
- En lokal modell föreslår simulerade åtgärder. En valfri nätverksmodell används bara om en nyckel finns i miljön.
- Ett kodlager granskar varje förslag innan något bokförs: hävstångstak, stopp, dagsförlust, affärstak och väntetid.
- Varje förslag loggas, med motivering och granskningsutfall, innan en order skickas till pappersmotorn.
- En mening på svenska eller engelska kan tolkas till en tiger. Konfigurationen visas och måste bekräftas.
- En tavla med status, procent, beslut och en intern topplista som bara visar procent.
- En kassa på 1000 DEMO som delas lika mellan de tre tigrarna. Ledig kassa kan flyttas tillbaka.
- Bara lekpengar och den befintliga prisadaptern (påhittad serie om ingen marknadsdatanyckel är satt).
- World-marknader på papper: simulerat flöde som standard, eller en lokal läsare på loopback som bara lämnar offentlig kedjedata (Solana-programkonton och Chainlink). Serierna är 15 minuter för BTC, ETH och SOL. Ingen PayBox-klient och ingen direkt hämtning från World.
- Tavlan visar marknaderna bara för den inloggade ägaren. Ingen export, delning eller offentlig visning. Internt bruk på localhost. Extern visning (demo, pitch, skärmdumpar, andra användare) kräver en ny juridisk granskning och `TIFI_MARKET_LABELS=neutral`, utan koppling till eller antytt partnerskap med World. Rå prishistorik sparas inte.

Det finns inget live-läge, ingen börsklient, ingen orderläggning mot en börs och ingen hantering av börsnycklar. Riktiga pengar mot World eller PayBox är inte tillåtna. Juridisk granskning har sagt nej, och det anropet är låst.

## Fas 2, riktiga pengar på OKX (byggs inte)

Det här avsnittet är bara en minneslista. Ingen del av den är implementerad.

Fas 2 får börja först efter ägarens uttryckliga skriftliga godkännande och efter en juridisk granskning av bolagets juridiska funktion. Att handla ägarens egna pengar är en sak. Att ta emot andras pengar kräver tillstånd från Finansinspektionen samt AML och MiCA.

Om det senare godkänns, och bara då, är de manuella stegen:

1. Ett OKX-underkonto per tiger.
2. API-nycklar med enbart Read och Trade. Aldrig Withdraw eller Transfer.
3. IP-allowlist mot servern.
4. Börja med OKX demo-trading-nycklar.
5. Minskad positionsstorlek de första timmarna.
6. En dokumenterad nedstängning som slutar skicka nya order och stänger öppna positioner (flatten).

I fas 1 vägrar koden att starta ett live-läge. Anropet kastar ett fel som säger att fas 2 kräver godkännande och juridisk granskning. Riktiga pengar mot World eller PayBox vägras alltid: juridisk granskning har sagt nej.
