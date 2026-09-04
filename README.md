# Kassify

Gemeinschaftskassen für den Unraid-Server.

## Start

Im Browser: `http://UNRAID-IP:8084`

Container-Port intern ist **80**. Host-Port ist **8084**.

```bash
docker pull ghcr.io/el-jimjoe/kassify:latest
docker stop kassify
docker rm kassify
docker run -d --name kassify --restart unless-stopped -p 8084:80 -v /mnt/user/appdata/kassify:/data ghcr.io/el-jimjoe/kassify:latest
```

In Unraid bei „Add Container“:

- Host Port: `8084`
- Container Port: `80` (nicht 8084)
- Volume: `/mnt/user/appdata/kassify` → `/data`

Beim ersten Aufruf Admin-Passwort setzen (mindestens 8 Zeichen).
