# Kassify

Kassensystem für den Unraid-Server. Alle Clients öffnen dieselbe Adresse, die Daten liegen in SQLite im Docker-Volume.

## Unraid

Image: `ghcr.io/el-jimjoe/kassify:latest`

- Port: Host `8080` → Container `80`
- Volume: `/mnt/user/appdata/kassify` → `/data`
- Restart: unless-stopped

Danach im Browser: `http://UNRAID-IP:8080`

Mit Compose auf Unraid:

```bash
docker compose up -d
```

Lokal aus dem Repo bauen:

```bash
docker compose up --build -d
```

### Passwort (optional)

Container-Variable:

```
KASSIFY_PASSWORD=dein-passwort
```

Ohne Variable ist die App im LAN offen.

## Speicher

- Artikel, Ladenname, MwSt.
- Abgeschlossene Verkäufe

Der offene Bon bleibt am jeweiligen Gerät, bis er abgeschlossen ist.
