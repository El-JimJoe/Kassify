# Kassify

Kassensystem als statische Web-App. Läuft lokal im Browser, auf GitHub Pages und per Docker auf Unraid.

## Lokal

`web/index.html` im Browser öffnen.

Oder mit Docker:

```bash
docker compose up --build
```

Danach: [http://localhost:8080](http://localhost:8080)

## GitHub Pages

1. Repo auf GitHub anlegen und dieses Projekt pushen.
2. Unter **Settings → Pages** als Quelle **GitHub Actions** wählen.
3. Der Workflow `.github/workflows/pages.yml` veröffentlicht den Ordner `web/`.

## Unraid (Docker)

Nach dem ersten Push baut `.github/workflows/docker.yml` ein Image nach `ghcr.io/<user>/kassify:latest`.

Im Unraid-Docker-Tab:

- Repository: `ghcr.io/<dein-github-user>/kassify:latest`
- Port: Host `8080` → Container `80`
- Restart: unless-stopped

Lokal bauen geht ebenfalls:

```bash
docker compose up --build -d
```

Artikel, Ladenname und MwSt. werden im Browser in LocalStorage gespeichert.
