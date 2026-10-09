#!/usr/bin/env bash
# Regenera los rangos de IP de Cloudflare para Nginx (real_ip) y recarga Nginx si la
# configuracion es valida. Los rangos cambian de vez en cuando: ejecutarlo a mano la primera
# vez y luego semanalmente (cron.weekly o un timer de systemd).
#
#   sudo deploy/update-cloudflare-ips.sh
#
# Si la descarga falla o devuelve algo raro NO toca el archivo actual.
set -euo pipefail

OUT="${1:-/etc/nginx/conf.d/cloudflare_realip.inc}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fetch() { curl -fsS --max-time 20 "https://www.cloudflare.com/$1"; }

{
  echo "# Generado por deploy/update-cloudflare-ips.sh el $(date -u +%FT%TZ). No editar a mano."
  for list in ips-v4 ips-v6; do
    body="$(fetch "$list")"
    # Solo lineas con forma de CIDR: ante cualquier otra cosa se aborta.
    if [ -z "$body" ] || echo "$body" | grep -vqE '^[0-9a-fA-F:.]+/[0-9]+$'; then
      echo "Respuesta inesperada de $list; no se actualiza nada." >&2
      exit 1
    fi
    echo "$body" | sed 's/^/set_real_ip_from /; s/$/;/'
  done
  echo "real_ip_header CF-Connecting-IP;"
} > "$TMP"

install -m 644 "$TMP" "$OUT"
nginx -t
systemctl reload nginx
echo "Rangos de Cloudflare actualizados en $OUT"
