#!/bin/sh
set -e
mkdir -p "${KASSIFY_DATA:-/data}"
python3 -u /app/server.py &
i=0
while [ "$i" -lt 20 ]; do
  if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/api/health')" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.3
done
exec nginx -g "daemon off;"
