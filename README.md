# 🔥 Okazje Wrocław

Aplikacja webowa, która zbiera w jednym miejscu:

- **💸 Okazje poniżej ceny** — oferty z **OLX** (oficjalne API JSON), **Allegro Lokalnie** (Wrocław) i **Vinted** (wysyłka PL) poniżej podanej ceny.
  Przy wpisanej frazie liczy **medianę rynkową** i oznacza 🔥 **perełki** (≥30% taniej niż rynek). Filtry: cena od/do, wykluczone słowa (np. `etui, szkło`), „bez firm”, sortowanie.
- **🎁 Za darmo** — wszystko „oddam za darmo” z OLX, Allegro Lokalnie i **grup Facebooka** (np. „Oddam za darmo Wrocław”, „Śmieciarka jedzie Wrocław”). Ogłoszenia „przyjmę / szukam” są domyślnie ukryte.
- Auto-odświeżanie (1–15 min), znaczek **NOWE**, powiadomienia w przeglądarce o nowych rzeczach, ⭐ zapisane, ukrywanie ogłoszeń. Działa na telefonie (można dodać do ekranu głównego).

Zero zależności: sam Node.js (18.17+).

## Uruchomienie

```bash
npm start
# → http://localhost:3000
```

Testy: `npm test`.

## Hosting

Aplikacja potrzebuje **Node.js** (zwykły hosting „tylko PHP” nie wystarczy). Sprawdzone opcje:

| Gdzie | Jak |
|---|---|
| Własny komputer / Raspberry Pi | `npm start` — najlepsza opcja dla OLX (domowe IP) |
| VPS (np. mikr.us, OVH, Hetzner) | `npm start` pod `pm2`/`systemd` albo Docker |
| Render / Railway / Fly.io | Wskaż repo, komenda startu `npm start` (albo Dockerfile) |
| Docker | `docker build -t okazje . && docker run -d -p 3000:3000 -v okazje-data:/app/data okazje` |

### Seohost (DirectAdmin) + Cloudflare

1. DirectAdmin → **Menedżer plików** → utwórz katalog `apps/okazje` (poza `public_html`) i wgraj tam zawartość repo (ZIP → *Rozpakuj*).
2. DirectAdmin → **Setup Node.js App** → *Create Application*: Node.js **22**, tryb **Production**, *Application root* `apps/okazje`, *Application URL* Twoja domena, *Application startup file* **`app.cjs`**.
3. Zmienne środowiskowe: `IMPORT_TOKEN` (dowolne hasło) i `PUBLIC_URL` (np. `https://okazje.twojadomena.pl`). *Create* → *Restart*.
4. Cloudflare: rekord DNS `A` na IP serwera Seohost (pomarańczowa chmurka), SSL/TLS **Full (strict)**, wyłącz **Rocket Loader**.

Po każdej zmianie plików kliknij *Restart* w Setup Node.js App. Błędy są w `stderr.log` w katalogu aplikacji.

### ⚠ Ważne: OLX blokuje IP serwerowni

OLX (przez CloudFront) odrzuca zapytania z IP wielu chmur/hostingów (HTTP 403). Aplikacja radzi sobie z tym tak:

1. Pokazuje wyraźnie, że OLX jest zablokowany; Allegro Lokalnie i FB działają dalej.
2. Jeśli masz zainstalowany skrypt Tampermonkey (patrz niżej), **OLX jest pobierany z Twojej przeglądarki, z Twojego domowego IP** — w zakładce widać wtedy „OLX: N (przez przeglądarkę)”.

Uruchomiona u siebie na komputerze lub na polskim VPS-ie zwykle pobiera OLX bezpośrednio.

## Grupy Facebooka (oddam za darmo / śmieciarka jedzie)

Facebook **nie ma API** do czytania grup, a posty widać tylko po zalogowaniu. Dlatego posty zbiera skrypt w Twojej przeglądarce:

1. Zainstaluj [Tampermonkey](https://www.tampermonkey.net/).
2. W aplikacji wejdź w zakładkę **👥 Grupy FB** → **Zainstaluj skrypt importu** (adres serwera wstawia się sam).
3. Otwórz grupę na FB i kliknij w prawym dolnym rogu **„Śledź tę grupę”**.
4. Zostaw kartę otwartą: skrypt przełącza na „najnowsze posty”, przewija, co 10 min odświeża i wysyła posty do aplikacji.

Skrypt działa tylko na grupach, które sam włączysz. Posty trzymane są w `data/facebook-posts.json` (domyślnie 14 dni).

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3000` | port HTTP |
| `CITY_NAME` | `Wrocław` | nazwa w interfejsie |
| `OLX_CITY_ID` | `19701` | ID miasta w OLX (Wrocław) |
| `OLX_DISTANCE` | — | promień w km od miasta (OLX) |
| `ALLEGRO_CITY` | `wroclaw` | slug miasta w Allegro Lokalnie |
| `IMPORT_TOKEN` | — | **ustaw na publicznym hostingu**, żeby nikt obcy nie wrzucał postów do importu FB |
| `FB_GROUPS` | wyszukiwarka FB | lista grup: `Nazwa\|https://www.facebook.com/groups/123,Inna\|https://...` |
| `PUBLIC_URL` | wykrywany | publiczny adres aplikacji (wstawiany do skryptu Tampermonkey) |
| `DATA_DIR` | `./data` | gdzie zapisywać posty FB |
| `CACHE_TTL_SECONDS` | `90` | cache zapytań do serwisów (żeby nie dostać bana) |

## API

- `GET /api/deals?q=iphone&min=300&max=1500&sources=olx,allegro&sort=new|price|below&private=1&exclude=etui,szkło`
- `GET /api/free?sources=olx,allegro,fb&q=szafa&wanted=1`
- `POST /api/fb/import` — `{ posts: [...] }` (nagłówek `X-Import-Token`, jeśli ustawiony)
- `GET /api/fb`, `GET /api/health`
