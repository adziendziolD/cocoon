# CoCoon – Anleitung für Einsteiger

Diese Anleitung bringt CoCoon auf einen eigenen Server (z. B. einen gemieteten Linux-Server bei Hetzner, IONOS, …)
und erklärt die ersten Schritte in der Weboberfläche. Du brauchst keine Programmierkenntnisse – nur etwas Mut, ein paar
Befehle zu kopieren.

## Was ist CoCoon?

CoCoon ist eine Art „Werkstatt“ für KI-Coding-Agenten wie Claude Code oder OpenAI Codex. Jeder Agent arbeitet in einer
eigenen, abgeschotteten **Sandbox** – einem kleinen, isolierten Computer im Computer. So kann ein Agent nichts auf deinem
Server kaputt machen, und du entscheidest, was er darf (z. B. welche Internetseiten er erreichen kann).
Über die Weboberfläche siehst du live, was deine Agenten tun, und kannst ihnen Aufgaben geben.

## 1. Server vorbereiten (einmalig)

Empfohlen: Ubuntu 24.04, mindestens 4 CPU-Kerne, 8 GB RAM, 40 GB Speicher.
Verbinde dich per SSH mit deinem Server und führe diese Befehle aus:

CoCoon braucht eine „Sandbox-Technik“. Wähle **eine** davon (Docker ist am verbreitetsten, Podman läuft ohne Root,
bubblewrap ist am leichtesten):

```bash
# Variante A – Docker
curl -fsSL https://get.docker.com | sh
# Variante B – Podman (kein Hintergrunddienst, kein Root):  sudo apt install -y podman
#              danach als cocoon-Benutzer: systemctl --user enable --now podman.socket
# Variante C – bubblewrap (sehr leicht, keine Images): sudo apt install -y bubblewrap tmux git

# Node.js 24 und pnpm installieren
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pnpm

# Eigenen Benutzer für cocoon anlegen (darf Docker benutzen)
sudo useradd --system --create-home --groups docker cocoon
```

## 2. CoCoon installieren

```bash
sudo -u cocoon -i
git clone <URL-dieses-Repositories> cocoon && cd cocoon
pnpm install
pnpm build:web
pnpm start
```

Beim ersten Start erscheint in der Konsole eine Zeile wie:

```
  Log in: http://127.0.0.1:7420/?token=cct_…
```

(Konsolenmeldungen sind standardmäßig auf Englisch; unter *Einstellungen → Allgemein* auf Deutsch umstellbar.)

Der Token liegt auch in der Datei `.data/admin-token.txt`. Im Hintergrund richtet CoCoon jetzt automatisch alles ein
(Netzwerk-Schutz, Sandbox-Image) – das kann beim ersten Mal einige Minuten dauern.

## 3. Von deinem Rechner aus zugreifen

CoCoon ist aus Sicherheitsgründen nur auf dem Server selbst erreichbar. Der einfachste sichere Weg von deinem Laptop:
ein **SSH-Tunnel**. Auf deinem Laptop:

```bash
ssh -L 7420:127.0.0.1:7420 benutzer@dein-server
```

Solange dieses Fenster offen ist, öffnest du im Browser den Anmelde-Link aus Schritt 2 (`http://127.0.0.1:7420/?token=…`).

Für dauerhaften Zugriff mit eigener Domain und HTTPS: [Caddy](https://caddyserver.com) installieren und `deploy/Caddyfile`
verwenden (Domain eintragen). Alternativ ein VPN wie [Tailscale](https://tailscale.com).

## 4. Erste Schritte in der Weboberfläche

Nach der ersten Anmeldung öffnet sich automatisch der **Einrichtungsassistent** und führt dich Schritt für Schritt durch alles
Folgende – folge ihm einfach. Du kannst ihn jederzeit unter *Einstellungen → Allgemein* erneut starten. Das sind die Schritte:

1. **Sandbox-Image** – wird automatisch gebaut; sonst auf „Bauen“ klicken.
2. **Zugangsdaten** – unter *Einstellungen → Zugangsdaten* deinen Anthropic API-Key (für Claude Code) oder OpenAI API-Key (für Codex)
   eintragen. Der Key bleibt auf dem Server; Agenten bekommen ihn im Standard-Netzwerkmodus nicht einmal zu sehen.
3. **Sandbox erstellen** – Name vergeben, optional die Adresse eines GitHub-Repositories angeben, Internetzugang
   „Eingeschränkt (empfohlen)“ lassen.
4. **Agent starten** – in der Sandbox „Agent starten“, z. B. *Claude Code*, und eine Aufgabe beschreiben
   („Schreibe Tests für …“).
5. Im **Agenten-Fenster** siehst du das Terminal live. Wenn der Agent eine Frage hat (gelber Hinweis
   „wartet auf deine Entscheidung“), kannst du per Knopfdruck antworten.
6. Unter **Änderungen** siehst du, was der Agent verändert hat – und kannst es herunterladen, auf GitHub hochladen
   oder direkt einen Pull Request erstellen (dafür einen GitHub-Token unter Zugangsdaten hinterlegen).

### Agenten nach Zeitplan arbeiten lassen

Unter **Zeitpläne** (oder im Reiter *Zeitpläne* eines Workspaces) auf *Neuer geplanter Agent* klicken, auswählen, was er tun soll –
**Alle Checks ausführen** (Linting, Typprüfung, Tests, Build, Audit), **Abhängigkeiten aktualisieren**, **Sicherheits-Check** oder
eigene Anweisungen – und wann (z. B. täglich um 3 Uhr, montags um 4 Uhr). Jeder Lauf erscheint als Aufgabe auf dem Board. Meldet der
Agent, dass alles in Ordnung ist, schließt sich der Lauf selbst ab; findet er etwas oder ändert er Dateien, wartet die Aufgabe in
*Prüfen* auf dich und du bekommst eine Benachrichtigung. Mit *Jetzt ausführen* probierst du ihn sofort aus.

## 5. Dauerhaft im Hintergrund laufen lassen

Damit CoCoon nach einem Neustart des Servers automatisch startet: `deploy/cocoond.service` (Pfade anpassen) nach
`/etc/systemd/system/` kopieren und `sudo systemctl enable --now cocoond` ausführen.

## Häufige Fragen

**Ein Agent kommt nicht ins Internet / Installation schlägt fehl.**
Im Modus „Eingeschränkt“ sind nur freigegebene Seiten erreichbar. Unter *Einstellungen → Netzwerk & Sicherheit* siehst du
blockierte Verbindungen und kannst sie mit einem Klick erlauben.

**Laufen geplante Agenten auch, wenn kein Browser offen ist?**
Ja – der Zeitplan läuft im Server. War der Server zum geplanten Zeitpunkt aus, wird der verpasste Lauf nach dem Start einmal nachgeholt.

**Ich habe den Anmelde-Token verloren.**
Er steht in `.data/admin-token.txt` auf dem Server. Weitere Tokens (z. B. für die CLI) erstellst du unter
*Einstellungen → Zugriff & Integrationen*.

**Kann ich CoCoon aus Claude Code heraus steuern?**
Ja – unter *Einstellungen → Zugriff & Integrationen* findest du den fertigen Befehl, um CoCoon als MCP-Server einzubinden.

**Kann ich meine eigene API / ein anderes Modell benutzen?**
Ja – unter *Einstellungen → API-Anbieter* fügst du z. B. dein Firmen-Gateway, OpenRouter, ein lokales Ollama oder eine beliebige
eigene HTTP-API hinzu (Vorlagen vorhanden), trägst den Schlüssel ein und klickst auf „Verbindung testen“. Danach kannst du den Anbieter
einem Agent-Typ zuweisen oder beim Start eines Agenten auswählen. Der Schlüssel bleibt auf dem Server.

**Gibt es die Oberfläche auch auf Englisch?**
Ja – die Oberfläche folgt der Sprache deines Browsers (sonst Englisch). Unten in der Seitenleiste kannst du jederzeit zwischen DE und EN umschalten.

**Wie viele Sandboxes kann ich gleichzeitig betreiben?**
Standardmäßig 20; jede Sandbox bekommt Grenzen für CPU und Arbeitsspeicher (einstellbar unter *Sandbox-Standards*).
