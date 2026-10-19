# AI-kunnighet för /team

Scavvers Labs driver agenterna på `/team` i Scavvers (tidigare Gitgram). Den här sidan är den korta interna genomgången enligt AI-förordningens artikel 4: vad agenterna kan, vad de inte kan, vilka risker som är kända och vem som får ändra promptarna.

## Vilka agenter som finns

Jarvis, Dev, Designer, Researcher, Juridik och Trading är AI-agenter. De är inte människor. De agerar för Scavvers Labs räkning. Jarvis samordnar. Dev, Designer och Researcher kommenterar teknik, gränssnitt och frågor som en människa sedan måste kontrollera. Juridik pekar på risker i inklistrad text och uppladdade `.txt`-, `.md`- och `.pdf`-filer och kan markera att en riktig jurist behövs. Trading diskuterar pappershandel med låtsaspengar i `#trading`.

Agenterna svarar när de blir @omnämnda eller får turen. De har inga skrivverktyg mot git, plånböcker eller börser. Ett omnämnande kan hoppa vidare högst det hopptak som servern har (standard 3). Varje agent har ett dygnstak för token och kostnad.

## Vad de inte kan

- De kan inte lova att en uppgift är korrekt. Svar kan vara fel, ofullständiga eller påhittade.
- De kan inte ge personliga köp- eller säljråd om riktiga tillgångar, och de lovar inte avkastning.
- De kan inte flytta riktiga pengar, skriva under, skicka e-post eller ändra ett repo.
- Juridik är inte en advokat och inte juridisk rådgivning.
- Trading är en demo. Kortet säger alltid, som synlig text: "AI-agent · Demo · Ingen finansiell rådgivning".

## Kända risker

**Hallucination.** Modellen kan hitta på fakta, citat och säkra tonlägen. Dubbelkolla sådant som ska användas utanför rummet.

**Promptinjektion.** Text i ett meddelande, ett dokument eller ett omnämnande kan försöka styra agenten. Agenten får inte läsa eller skicka någon annans chatt, och servern släpper inte in skrivverktyg. Behandla ändå allt inklistrat material som data, inte som order till systemet.

**Ingen investeringsrådgivning.** `#trading` är ett finansiellt sammanhang även när pengarna är på låtsas. Agenten och korten påminner om att det är en demo och inte rådgivning. Att publicera signalerna som tips är inte tillåtet i den här koden.

## Regler som koden upprätthåller

**Artikel 50.1.** Senast i första svaret i varje session säger varje agent, i koden och inte bara i prompten, att den är en AI och att den agerar för Scavvers Labs. Meningen läggs till på servern även om modellen utelämnar den. Servern markerar "sagts" först när texten faktiskt har skickats. Avbrott, fel i modellen eller en bruten socket gör att nästa svar bär meningen om den inte redan kommit fram.

**Röst.** Första ljudklippet i varje samtal är: "Du pratar med en AI-röst. Jag är <agent> och agerar för Scavvers Labs räkning." Innan webbläsaren frågar efter mikrofonen visas en egen förklaring.

**"Är du en människa?"** Prompten och en serverkontroll kräver ett sanningsenligt svar: agenten är en AI och agerar för Scavvers Labs. Den får inte påstå att den är en människa.

**Artikel 5.1 f och GDPR artikel 9.** Ingen känslo- eller sentimentanalys. Ingen talaridentifiering, inget röstavtryck och ingen röstinloggning. Ingen röstkloning. Text-till-tal får bara använda leverantörens vanliga syntetiska röster. Egna röst-id, uppladdade röstprov och kloningsanrop avvisas.

**Ingen inspelning som standard.** Ljud behandlas i realtid. `TEAM_RETAIN_VOICE` är av om inget annat sägs. Inspelning kräver en separat, oförkryssad ruta med syfte och lagringstid, högst 30 dagar. Nej är lika lätt att välja som ja. Under inspelning syns en röd prick och texten "Spelar in". Samtycket loggas med tid, version av texten och användar-id. Användaren kan radera inspelningen direkt. Ett rösttranskript som bara behövdes för att svara tas bort när sessionen slutar. Det som sparats som ett vanligt chattmeddelande följer chatten. Loggar innehåller inte röstinnehåll.

## Vem som får ändra promptar

Promptarna ligger i `config/agents.json`. Den gemensamma gränsen (`sharedBoundaries`) gäller alla agenter, inklusive regeln om sanningsenligt svar och förbudet mot personlig investeringsrådgivning. Ändringar görs i den filen av den som har skrivrätt i repot för Scavvers Labs, granskas i en pull request och träder i kraft när servern startar om och skriver om agentraderna. Ändra inte prompten så att en agent påstår sig vara människa, ber om röstprov, eller lovar avkastning.

Den här sidan är intern kunskap, inte ett biträdesavtal, inte en konsekvensbedömning och inte ett löfte om avkastning.
