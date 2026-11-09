#!/usr/bin/env bash
# Instala una version nueva de la API junto a la actual, la prueba y solo entonces la activa.
# Si la nueva no arranca, la vigente ni se toca; si falla despues de activarla, vuelve sola
# a la anterior.
#
#   release.sh <sha>
#
# El codigo NO se sube: el servidor lo trae de GitHub (`git fetch` a un clon local) y comprueba
# que el commit pertenece a main. Nunca se hace `git pull` sobre la version en servicio: cada
# version se extrae con `git archive` en su propia carpeta.
#
# Estructura en el servidor:
#   /opt/eduteka/repo.git                  clon (bare) del repositorio; solo lectura desde GitHub
#   /opt/eduteka/releases/<fecha>-<sha>/   cada version, con su propio node_modules
#   /opt/eduteka/current -> releases/…     la version activa (enlace simbolico)
#   /opt/eduteka/shared/.env               variables de produccion (no van en el codigo)
#   /var/lib/eduteka/…                     datos (STORAGE_DIR, comprobantes): sobreviven a los despliegues
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Uso: release.sh <sha de 40 caracteres>" >&2; exit 2; }

BASE="${BASE:-/opt/eduteka}"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
SHARED_ENV="$BASE/shared/.env"
REPO="$BASE/repo.git"
REPO_URL="${REPO_URL:-git@github.com:JoseTaquiriVicerrel/api.eduteka.git}"
BRANCH="${BRANCH:-main}"
# Llave de SOLO LECTURA (Deploy key de GitHub), distinta de la que usa Actions para entrar aqui.
export GIT_SSH_COMMAND="ssh -i ${GITHUB_KEY:-$HOME/.ssh/github_deploy} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"
SERVICE="${SERVICE:-eduteka-api}"
# Procesos de fondo del mismo codigo (puerto local de /health de cada uno). Solo se reinician los
# que estan habilitados en este servidor (`systemctl is-enabled`); los demas se ignoran, asi el
# script sirve igual antes y despues de instalar cada unidad.
EXTRA_SERVICES="${EXTRA_SERVICES:-eduteka-worker:3003}"
LIVE_PORT="${LIVE_PORT:-3000}"
SMOKE_PORT="${SMOKE_PORT:-3101}"
KEEP="${KEEP:-5}"

ID="$(date -u +%Y%m%d-%H%M%S)-${SHA:0:7}"
DIR="$RELEASES/$ID"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
SWITCHED=0
SMOKE_PID=""

log() { echo "[$(date +%T)] $*"; }

# Un solo despliegue a la vez (GitHub ya los encola; esto protege de una ejecucion manual).
mkdir -p "$RELEASES"
exec 9> "$RELEASES/.lock"
flock -n 9 || { echo "Ya hay un despliegue en curso." >&2; exit 1; }

on_exit() {
  local rc=$?
  [ -n "$SMOKE_PID" ] && kill "$SMOKE_PID" 2>/dev/null || true
  # Una version que no llego a activarse no se conserva.
  if [ "$rc" -ne 0 ] && [ "$SWITCHED" -eq 0 ]; then rm -rf "$DIR"; fi
  exit "$rc"
}
trap on_exit EXIT

wait_healthy() { # puerto, segundos
  local port="$1" seconds="$2" i
  for i in $(seq 1 "$seconds"); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/v1/health" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    sleep 1
  done
  return 1
}

wait_process_healthy() { # puerto, segundos  (procesos de fondo: GET /health en 127.0.0.1)
  local port="$1" seconds="$2" i
  for i in $(seq 1 "$seconds"); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    sleep 1
  done
  return 1
}

# Reinicia los procesos de fondo habilitados y comprueba su /health. Devuelve 1 si alguno no responde.
restart_extras() {
  local entry unit port failed=0
  for entry in $EXTRA_SERVICES; do
    unit="${entry%%:*}"; port="${entry##*:}"
    systemctl is-enabled --quiet "$unit" 2>/dev/null || continue
    sudo -n /usr/bin/systemctl restart "$unit"
    if ! wait_process_healthy "$port" 30; then
      echo "El proceso $unit no responde en 127.0.0.1:$port/health." >&2
      journalctl -u "$unit" -n 30 --no-pager >&2 || true
      failed=1
    fi
  done
  return "$failed"
}

activate() { # directorio
  ln -sfn "$1" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
}

[ -f "$SHARED_ENV" ] || { echo "Falta $SHARED_ENV" >&2; exit 1; }

# Si GitHub no responde, el despliegue se aborta aqui, antes de tocar nada.
log "Descargando $BRANCH de GitHub"
if [ ! -d "$REPO" ]; then git clone --quiet --bare "$REPO_URL" "$REPO"; fi
git --git-dir="$REPO" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/heads/$BRANCH"

git --git-dir="$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { echo "El commit $SHA no existe en el repositorio." >&2; exit 1; }
# Solo se despliega codigo que ya esta en main (el que paso la CI y la revision).
git --git-dir="$REPO" merge-base --is-ancestor "$SHA" "refs/heads/$BRANCH" \
  || { echo "El commit $SHA no pertenece a $BRANCH; no se despliega." >&2; exit 1; }

log "Extrayendo $ID"
mkdir -p "$DIR"
# `git archive` respeta .gitattributes: sin pruebas, documentacion ni deploy/.
git --git-dir="$REPO" archive "$SHA" | tar -x -C "$DIR" --no-same-owner
echo "$SHA" > "$DIR/REVISION"
ln -s "$SHARED_ENV" "$DIR/.env"

log "Instalando dependencias (npm ci --omit=dev)"
( cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )

# Arranque de prueba con la configuracion REAL (Mongo, Redis, .env) pero en otro puerto y solo
# en local: una dependencia mal instalada, una variable que falta o un error al arrancar se
# detectan aqui, con la version anterior sirviendo todavia.
log "Prueba de arranque en 127.0.0.1:$SMOKE_PORT"
( cd "$DIR" && exec env NODE_ENV=production PORT="$SMOKE_PORT" LISTEN_HOST=127.0.0.1 node src/server.js > "$DIR/smoke.log" 2>&1 ) &
SMOKE_PID=$!   # con `exec`, es el PID de node (no el de un subshell que lo dejaria huerfano)
if ! wait_healthy "$SMOKE_PORT" 25; then
  echo "La version nueva no arranco o /health no esta en 'ok'. Ultimas lineas:" >&2
  tail -n 30 "$DIR/smoke.log" >&2 || true
  exit 1
fi
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
SMOKE_PID=""
rm -f "$DIR/smoke.log"

log "Activando $ID"
activate "$DIR"
SWITCHED=1
sudo -n /usr/bin/systemctl restart "$SERVICE"

API_OK=1
wait_healthy "$LIVE_PORT" 30 || API_OK=0
EXTRAS_OK=1
if [ "$API_OK" -eq 1 ]; then restart_extras || EXTRAS_OK=0; fi

if [ "$API_OK" -eq 0 ] || [ "$EXTRAS_OK" -eq 0 ]; then
  echo "La version activa no responde: volviendo a la anterior." >&2
  [ "$API_OK" -eq 0 ] && { journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true; }
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    activate "$PREVIOUS"
    sudo -n /usr/bin/systemctl restart "$SERVICE"
    if wait_healthy "$LIVE_PORT" 30 && restart_extras; then echo "Vuelta atras correcta a $(basename "$PREVIOUS")." >&2
    else echo "ATENCION: la version anterior tampoco responde del todo." >&2; fi
  fi
  exit 1
fi

log "Version $ID activa"

# Se conservan las ultimas $KEEP versiones (y siempre la activa y la anterior).
CUR="$(basename "$(readlink -f "$CURRENT")")"
PREV_NAME="$(basename "${PREVIOUS:-/}")"
ls -1 "$RELEASES" | sort | head -n "-$KEEP" | while read -r old; do
  [ "$old" = "$CUR" ] || [ "$old" = "$PREV_NAME" ] || rm -rf "${RELEASES:?}/$old"
done
log "Listo"
