# Kassify

Kassensystem als Web-App. Die **Daten liegen auf dem Unraid-Server** (SQLite im Docker-Volume), nicht im Browser. Alle Clients sehen denselben Bestand.

GitHub Pages kann nur die Oberfläche ausliefern. Gemeinsame Daten brauchen den Docker-Container.

## Docker / Unraid

```bash
docker compose up --build -d
```

App: [http://localhost:8080](http://localhost:8080)

Daten bleiben in Volume `kassify-data` (Pfad im Container: `/data`). Auf Unraid besser ein Host-Pfad mappen, z. B. `/mnt/user/appdata/kassify` → `/data`.

### Passwort (optional, später)

In `.env` oder in den Container-Variablen:

```
KASSIFY_PASSWORD=dein-passwort
```

Container neu starten. Die Web-App fragt dann nach dem Passwort. Ohne gesetztes Passwort ist die API im Netz erreichbar – nur im vertrauenswürdigen LAN nutzen.

## GitHub Pages als Oberfläche

1. Pages-Quelle: **GitHub Actions**
2. Unraid-Container erreichbar machen (LAN-IP, Reverse Proxy oder Tailscale)
3. In der App unter **Einstellungen → Server-URL** z. B. `http://192.168.1.10:8080/api` eintragen

Ohne diese URL speichert GitHub Pages nichts Gemeinsames.

## Was wird gespeichert?

- Artikel, Ladenname, MwSt.
- Abgeschlossene Verkäufe

Der aktuelle Bon bleibt am jeweiligen Gerät, bis er abgeschlossen ist.
