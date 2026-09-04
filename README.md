# Kassify

Gemeinschaftskassen für den Unraid-Server. Mehrere Kassen, Mitglieder, Getränke,
Kontoabgleich, Einkäufe, Sicherung.

## Start

```bash
docker compose up --build -d
```

Browser: `http://UNRAID-IP:8080`

Beim ersten Aufruf ein Admin-Passwort setzen (mindestens 8 Zeichen). Kein
Standardpasswort.

Unraid-Volume: `/mnt/user/appdata/kassify` → `/data`

## Rollen

Ein Passwort bestimmt Rolle und Kasse. Admin sieht alle Kassen. Editor und
Reader landen direkt in ihrer Kasse.
