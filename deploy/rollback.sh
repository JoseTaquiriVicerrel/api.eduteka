#!/usr/bin/env bash
# Vuelve a la version anterior (o a la indicada) sin reconstruir nada: cambia el enlace
# `current` y reinicia el servicio. Se ejecuta en el servidor:
#
#   sudo -u deploy /opt/eduteka/bin/rollback.sh                # la inmediatamente anterior
#   sudo -u deploy /opt/eduteka/bin/rollback.sh 20261009-1530-abc1234   # una concreta
#   ls /opt/eduteka/releases                                    # versiones disponibles
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

BASE="${BASE:-/opt/eduteka}"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
SERVICE="${SERVICE:-eduteka-api}"
LIVE_PORT="${LIVE_PORT:-3000}"

CUR="$(basename "$(readlink -f "$CURRENT")")"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  # La mas reciente anterior a la activa.
  TARGET="$(ls -1 "$RELEASES" | sort | awk -v cur="$CUR" '$0 < cur { last = $0 } END { print last }')"
fi
[ -n "$TARGET" ] || { echo "No hay una version anterior a $CUR." >&2; exit 1; }
[[ "$TARGET" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "Nombre de version invalido." >&2; exit 2; }
[ -d "$RELEASES/$TARGET" ] || { echo "No existe $RELEASES/$TARGET" >&2; exit 1; }

echo "Activando $TARGET (desde $CUR)"
ln -sfn "$RELEASES/$TARGET" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"
sudo -n /usr/bin/systemctl restart "$SERVICE"

for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$LIVE_PORT/api/v1/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "Listo: $TARGET responde."
    exit 0
  fi
  sleep 1
done
echo "ATENCION: $TARGET no responde en /health." >&2
exit 1
