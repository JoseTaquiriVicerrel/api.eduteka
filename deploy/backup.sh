#!/usr/bin/env bash
# Respaldo de la API: base de datos + archivos que NO se pueden regenerar.
#
#   Mongo           mongodump comprimido
#   Comprobantes    PAY_CAPTURE_DIR y FILES_ROOT_DIR/storage/payment (evidencia de pagos)
#   Avatares y resto de STORAGE_DIR, SIN la cache de formulas (storage/math: se regenera sola)
#
# Uso (cron diario, por ejemplo a las 03:30):
#   30 3 * * *  /opt/eduteka/api/deploy/backup.sh >> /var/log/eduteka-backup.log 2>&1
#
# Variables (todas opcionales salvo el .env):
#   ENV_FILE     .env de la API                      (por defecto /opt/eduteka/api/.env)
#   BACKUP_DIR   donde dejar los respaldos           (por defecto /var/backups/eduteka)
#   KEEP_DAYS    dias que se conservan               (por defecto 14)
#   REMOTE       destino fuera del servidor (rclone o rsync), p. ej. "rclone:b2:eduteka-backups"
#                o "usuario@otro-servidor:/respaldos/eduteka". Sin REMOTE el respaldo queda solo
#                en este servidor, que NO es un respaldo real si el disco falla.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/eduteka/api/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/eduteka}"
KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="${REMOTE:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Lee UNA variable del .env sin ejecutarlo (los valores pueden llevar espacios o simbolos).
env_get() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }

MONGODB_URI="$(env_get MONGODB_URI)"
STORAGE_DIR="$(env_get STORAGE_DIR)";           STORAGE_DIR="${STORAGE_DIR:-/opt/eduteka/api/storage}"
PAY_CAPTURE_DIR="$(env_get PAY_CAPTURE_DIR)"
FILES_ROOT_DIR="$(env_get FILES_ROOT_DIR)";     FILES_ROOT_DIR="${FILES_ROOT_DIR:-$(dirname "$STORAGE_DIR")}"
[ -n "$MONGODB_URI" ] || { echo "MONGODB_URI no esta en $ENV_FILE" >&2; exit 1; }

DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
chmod 700 "$BACKUP_DIR" "$DEST"

echo "[$(date +%T)] mongodump..."
mongodump --uri="$MONGODB_URI" --archive="$DEST/mongo.archive.gz" --gzip --quiet

echo "[$(date +%T)] archivos..."
tar -czf "$DEST/storage.tar.gz" --exclude='math' -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
[ -n "$PAY_CAPTURE_DIR" ] && [ -d "$PAY_CAPTURE_DIR" ] && tar -czf "$DEST/pay_capture.tar.gz" -C "$(dirname "$PAY_CAPTURE_DIR")" "$(basename "$PAY_CAPTURE_DIR")"
[ -d "$FILES_ROOT_DIR/storage/payment" ] && tar -czf "$DEST/payment.tar.gz" -C "$FILES_ROOT_DIR/storage" payment

( cd "$DEST" && sha256sum ./* > SHA256SUMS )

if [ -n "$REMOTE" ]; then
  echo "[$(date +%T)] copiando a $REMOTE..."
  case "$REMOTE" in
    rclone:*) rclone copy "$DEST" "${REMOTE#rclone:}/$STAMP" ;;
    *)        rsync -a "$DEST" "$REMOTE/" ;;
  esac
else
  echo "AVISO: REMOTE sin definir; el respaldo solo existe en este servidor." >&2
fi

# Rotacion local.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +
echo "[$(date +%T)] listo: $DEST"
