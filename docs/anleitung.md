# RunPod Launcher — Anleitung

Ein eigenes Sprachmodell auf gemieteter Hardware, erreichbar über die
OpenAI-Schnittstelle aus n8n, einem Agenten oder jedem anderen Client — und es
schläft, wenn niemand es benutzt.

Der Grund für das ganze Projekt in einer Zahl: eine GPU, auf die ein 27B-Modell
passt, kostet rund **400 $ im Monat, wenn sie durchläuft**.

> **Stand: v0.1.0.** Alles hier Beschriebene ist gebaut und an echter
> RunPod-Hardware gelaufen. Die Desktop-App ist **nicht signiert**, macOS und
> Windows warnen deshalb beim ersten Start — wie das zu umgehen ist, steht unten.

---

## Was wohin gehört

Zwei Teile, und die Trennung ist Absicht:

| | |
|---|---|
| **Dienst** | Ein kleiner Container, der neben dem läuft, was das Modell benutzt — n8n, ein Agent, eine Chat-Oberfläche. Er hält die Zugangsdaten, führt den Zeitplan aus und ist die Brücke zum Pod. Läuft durch, auch wenn dein Rechner zu ist. |
| **App** | Nur die Bedienung. Nichts geht kaputt, wenn sie geschlossen ist. |

Deine Clients sprechen **immer** mit dem Dienst, nie direkt mit dem Pod. Das ist
wichtig, weil sich die Adresse eines Pods (`https://<pod-id>-8000.proxy.runpod.net`)
bei jedem Neubau ändert — der Dienst fängt das ab, damit nichts dahinter neu
eingerichtet werden muss.

**Nichts Vertrauliches steht in einer Datei.** RunPod-Schlüssel,
HuggingFace-Token und Webhook-URL werden in der App eingetragen und verschlüsselt
abgelegt. In der Compose-Datei stehen nur Port, TLS-Betriebsart und Zeitzone.

---

## 1. Was du brauchst

- Einen **RunPod-Account** mit Guthaben und einen API-Schlüssel
  (RunPod → Settings → API Keys).
- Einen Ort für den Dienst: ein Server, ein NAS, ein VPS oder auch derselbe
  Rechner. Docker genügt.
- Optional einen **HuggingFace-Token**, wenn du zugangsbeschränkte Modelle
  benutzen willst. Ohne ihn funktionieren alle offenen Modelle.

---

## 2. Den Dienst installieren

> **Einmalig nötig, sonst scheitert der Download:** Neue GHCR-Pakete sind
> **privat**, auch bei einem öffentlichen Repo. Nach dem ersten
> Veröffentlichungslauf einmal auf GitHub → *Packages* → `runpod-launcher` →
> *Package settings* → *Change visibility* → **Public**. Ohne das antwortet
> `docker compose up` mit `unauthorized` oder `manifest unknown`.
>
> Das Image `:latest` folgt dem Stand von `main`. Versionierte Tags
> (`:0.1.0`) entstehen erst mit einer Release.

### Weg A — Docker Compose von Hand

```bash
curl -O https://raw.githubusercontent.com/LOGIN-TB/runpod-launcher/main/docker-compose.yml
docker compose up -d
docker compose logs | grep -A4 "Pair the launcher app"
```

Der letzte Befehl zeigt den **Kopplungscode**. Er gilt einmal und verfällt nach
30 Minuten. Läuft der Dienst auf einem anderen Rechner, brauchst du dessen
Adresse — `http://<rechner>:8080`.

Der Dienst erzeugt sich beim ersten Start ein eigenes Zertifikat, und die App
merkt sich dessen Fingerabdruck. Ändert er sich später, verweigert die App die
Verbindung.

### Weg B — Coolify

**New Resource → Docker Compose**, dieses Repository angeben. Coolify liest die
`docker-compose.yml`, vergibt eine Unterdomäne und stellt das Zertifikat selbst
aus. Der Kopplungscode steht direkt in Coolifys Oberfläche unter den
Umgebungsvariablen als `SERVICE_PASSWORD_PAIRING` — kein Suchen in Logs.

Setze dort **`TLS_MODE=proxy`**. Dann spricht der Dienst intern nur HTTP, und die
App prüft die Zertifikatskette ganz normal statt sie festzunageln. Das ist
wichtig: Let's-Encrypt-Zertifikate werden alle 90 Tage erneuert, und ein fest
gemerkter Fingerabdruck würde dich nach drei Monaten aussperren.

### Prüfen, ob er läuft

```bash
curl http://localhost:8080/health
```

Antwortet `{"status":"ok","paired":false,...}`, steht er.

---

## 3. Die App

Fertige Programme hängen an jeder Release. Ohne Signierung gilt beim **ersten**
Start je Version:

- **macOS:** Rechtsklick auf die App → *Öffnen* → *Öffnen*.
- **Windows:** *Weitere Informationen* → *Trotzdem ausführen*.

Selbst bauen geht auch, dafür braucht es Node 24 und eine Rust-Toolchain
(`rustup`):

```bash
npm install
npm run app:build -w @runpod-launcher/desktop
```

---

## 4. Einrichten

Die App führt dich durch die vier Schritte und **prüft jeden selbst** — sie
fragt nicht, ob du etwas getan hast, sondern sieht beim Dienst nach.

1. **Koppeln.** Adresse des Dienstes und Kopplungscode eintragen. Die App
   tauscht den Code gegen ein Gerätetoken und legt es im Schlüsselbund
   (macOS) bzw. in der Anmeldeinformationsverwaltung (Windows) ab.
2. **RunPod-Schlüssel eintragen** unter *Einstellungen*. Mit „Schlüssel prüfen"
   siehst du sofort, ob RunPod ihn annimmt.
3. **Eine Vorlage anlegen** unter *Vorlagen*. Dazu unten mehr.
4. **Pod erstellen** — in der Vorlagenliste, bei der Vorlage, die er benutzen
   soll. Der erste Start lädt das Modell: bei 20 GB fünf bis fünfzehn Minuten.
   In der Pod-Liste steht er so lange auf „Wird vorbereitet" und wechselt auf
   „Einsatzbereit", sobald der Motor antwortet. Mit „Testanfrage senden" prüfst
   du, ob es wirklich läuft — „läuft" und „antwortet" sind nicht dasselbe.
5. **Zugang anlegen** unter *Zugänge*, mit der Vorlage als Ziel. Der Token wird
   **einmal** angezeigt; der Dienst speichert nur einen Hash davon.

---

## 5. Eine Vorlage anlegen

Eine Vorlage sagt, was laufen soll: ein Image, ein Chat-Modell, ein
Embedding-Modell, eine GPU und wie er schlafen soll. Beide Modellplätze sind
optional und unabhängig — nur Chat, nur Embedding, oder beides auf einer Karte.

Das Embedding-Modell ist neben dem Chat-Modell winzig (etwa 1 GB gegen 27 GB),
beides auf einer GPU kostet also nichts extra. Ist nur ein Platz belegt, bekommt
er den VRAM-Anteil des anderen — und das kauft direkt Kontextlänge.

**Die App prüft vor dem Speichern**, ob das Modell überhaupt laufen kann:
Format gegen Motor (GGUF gehört zu llama.cpp, nicht zu vLLM), Format gegen Karte
(FP8 braucht Ada oder Blackwell) und Größe gegen VRAM. Jede dieser drei Fragen
ist sonst ein Weg, vier Minuten in einen bezahlten Start hinein zu scheitern.

**Der Kontext startet bei dem, was passt** — dem größten Fenster, das die Karte
mit diesen Gewichten halten kann, gedeckelt durch das, was das Modell selbst
kann. Beide Grenzen zählen: zu groß für die Karte verschwendet den Download, zu
groß für das Modell lässt den Motor gar nicht erst starten, und zwar erst
nachdem die Gewichte da sind.

**Werkzeugaufrufe werden aus dem Modell gelesen, nicht aus seinem Namen
geraten.** vLLM weist jede Anfrage mit Werkzeugen ab, solange kein Parser
gesetzt ist, und der Parser muss zum Format passen, das das Modell wirklich
ausgibt. Die App liest dafür die Chat-Vorlage des Modells. Beides steht unter
*Erweitert* und ist überschreibbar.

### Schlafmodus

| | Anhalten und fortsetzen | Jedes Mal neu bauen |
|---|---|---|
| Aufwachzeit | 1–2 min | 2–4 min |
| Kosten im Ruhezustand | Volume zum **doppelten** Satz | nur Netzlaufwerk (~7 $/Monat je 100 GB) |
| GPU beim Aufwachen | **kann ganz fehlen** | irgendeine verfügbare Karte |
| Pod-Adresse | bleibt | jedes Mal neu (der Dienst verbirgt das) |

RunPod sagt ausdrücklich, dass ein fortgesetzter Pod null GPUs zugeteilt bekommen
kann, wenn die Kapazität weitergezogen ist. Der Dienst erkennt das und baut neu,
statt dir einen Pod zu lassen, der Speicher berechnet und nichts bedient.

---

## 6. Einen Client verbinden

Jeder OpenAI-kompatible Client funktioniert. Adresse des Dienstes plus ein
Zugangstoken aus der App:

```bash
curl http://dein-server:8080/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen/Qwen3.8-27B-FP8", "messages": [{"role":"user","content":"Hallo"}]}'
```

| Client | Wo die Adresse hingehört |
|---|---|
| n8n | OpenAI-Zugangsdaten → *Base URL* |
| Open WebUI | Einstellungen → Verbindungen → OpenAI API |
| LibreChat | `librechat.yaml` → eigener Endpunkt |
| Hermes / OpenClaw | die OpenAI-Basis-URL in der Modellkonfiguration |
| Python | `OpenAI(base_url=..., api_key=...)` |

**Zugangstoken dürfen nur das Modell benutzen.** Sie können keinen Pod starten
und keine Einstellungen lesen — ein Token, das aus einem n8n-Workflow entwischt,
kann dir also keine Hardware anmieten. Die Steuerung hängt am Gerätetoken, das
die App hält.

---

## 7. Zuordnungen: welche Anwendung welchen Pod erreicht

Jeder Zugang zeigt auf **eine** Vorlage, und die entscheidet, auf welchem Pod
eine Anfrage landet. n8n auf einem Server und ein Agent auf dem Schreibtisch
können sich einen Pod teilen oder jeder seinen eigenen haben — mehrere Zugänge
auf einer Vorlage sind ein Pod, je ein Zugang sind zwei.

Das Ziel hängt am **Zugang**, nicht an der Anwendung. n8n auf andere Hardware
umzuhängen ist deshalb eine Änderung im Launcher und **keine** in n8n: das
Zugangsdatum, das dort liegt, bleibt gültig.

Der Bereich **Zuordnungen** zeigt die Paare, den Zustand des jeweiligen Pods —
und den teuren Fall: ein Pod, der läuft und auf den niemand zeigt.

Zwei Folgen, die man kennen sollte:

- Ein Zugang weckt nur **seinen eigenen** Pod, und nur innerhalb des Zeitplans
  seiner Vorlage. Ein Agent kann nicht versehentlich die GPU starten, die eine
  andere Anwendung mietet.
- `/v1/models` nennt nur, was die Vorlage dieses Zugangs bedient, und liefert die
  Kontextlänge mit — damit ein Client seine Anfragen passend zuschneiden kann,
  statt zu raten.

**„Pods gleichzeitig"** in den Einstellungen ist die Obergrenze dafür, wie viele
GPUs zugleich gemietet werden dürfen. Vorgabe ist 2. Tages- und Monatsgrenze
gelten weiterhin für alle zusammen.

---

## 8. Schlafen lassen

Der eigentliche Zweck. Drei Regeln greifen übereinander:

| | |
|---|---|
| **Zeitplan** | An zwischen den Zeiten, die du setzt, an den Tagen, die du wählst |
| **Leerlauf-Abschaltung** | Aus nach N Minuten ohne Anfrage, auch mitten im Fenster |
| **Ausgabengrenze** | Sofort aus bei Tages- oder Monatslimit, egal was sonst gilt |

Die Zeitzone gehört zum Zeitplan, nicht zum Server: ein Container auf einem VPS
läuft in UTC, und `07:00` soll sieben Uhr morgens **bei dir** heißen.

Eine Leerlauf-Abschaltung wird vom Zeitplan **nicht** wieder aufgehoben. Einmal
wegen Leerlauf gestoppt, bleibt der Pod unten, bis das Fenster erneut beginnt
oder eine Anfrage kommt. Das falsch zu machen ergab eine Start-Stopp-Schleife,
die alle paar Minuten eine frische GPU gemietet hat.

**Eine Anfrage weckt einen schlafenden Pod.** Das Gateway hält die Verbindung
offen, während der Motor hochkommt, statt sofort abzulehnen — nur so
funktioniert es mit Clients, die vom Launcher nichts wissen. Ein Agent hat
keinen Grund, vorher irgendeinen Weck-Endpunkt aufzurufen. Setze die Wartezeit
länger als einen Kaltstart: etwa fünf Minuten für ein 20-GB-Modell, mehr wenn es
erst geladen werden muss.

### Ausgabengrenzen

Ein **leeres Feld heißt: keine Grenze** — dann läuft ein vergessener Pod, bis es
jemandem auffällt. Die Beträge sind US-Dollar, so rechnet RunPod ab. Unter
*Ausgaben* stehen die Grenzen ausgeschrieben, und eine nicht gesetzte steht in
Rot, weil das bei einem Werkzeug mit Stundenmiete kein neutraler Zustand ist.

---

## 9. Wenn etwas nicht geht

| Meldung | Was sie bedeutet |
|---|---|
| `Unter dieser Adresse antwortet nichts` | Der Container läuft nicht, oder die Adresse ist falsch. `curl http://<host>:8080/health`. |
| `client_unassigned` (HTTP 400) | Der Zugang hat keine Ziel-Vorlage. Unter *Zuordnungen* zuweisen. |
| `outside_scheduled_hours` (HTTP 503) | Der Zeitplan dieser Vorlage sagt gerade Nein. Von Hand starten, wenn du es jetzt brauchst. |
| `model_loading` (HTTP 503) | Der Pod fährt noch hoch. Die Wartezeit steht in der Meldung. |
| `"auto" tool choice requires --enable-auto-tool-choice` | Die Vorlage hat keinen Werkzeug-Parser. Modell in der Vorlage neu auswählen, dann wird er erkannt. |
| `max_tokens=… cannot be greater than max_model_len=…` | Der Client verlangt mehr Ausgabe-Token als das Fenster hergibt. Kontext der Vorlage erhöhen — der Pod muss dafür neu gebaut werden. |
| `No capacity for …` | Diese Karte ist gerade nicht zu haben. Ausweichkarten in der Vorlage eintragen. |

Änderungen an einer Vorlage erreichen einen **laufenden** Pod nicht — die
Argumente stehen fest, sobald er gestartet ist. Der Pod merkt sich, womit er
gebaut wurde, und lehnt ein Fortsetzen selbst ab, wenn die Vorlage sich
geändert hat; er wird dann neu gebaut statt still im alten Zustand
zurückzukommen.

Unter *Aktivität* auf der Übersicht steht, warum sich etwas geändert hat — jeder
Start, jeder Stopp und jede Einstellungsänderung mit Grund und Zeitpunkt.

---

## 10. Sicherheit, kurz

- Gerätetoken mit 256 Bit Zufall, im Dienst nur als Hash, je Gerät widerrufbar.
- Kopplungscode einmalig, mit Ablauf.
- Zugangstoken dürfen ausschließlich das Modell benutzen.
- Geheimnisse werden nie zurückgeliefert und nie protokolliert.
- Ausgabengrenze und maximale Laufzeit als letzte Reißleine.
- Der Quelltext ist öffentlich, die Sicherheit beruht also nicht auf
  Verschleierung: keine eingebauten Standardschlüssel, kein Standardpasswort,
  keine Testzugänge. Ohne Kopplung ist der Dienst unbenutzbar.
