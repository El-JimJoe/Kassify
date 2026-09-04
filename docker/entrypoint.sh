#!/bin/sh
set -e
mkdir -p "${KASSIFY_DATA:-/data}"
python3 /app/server.py &
exec nginx -g "daemon off;"
