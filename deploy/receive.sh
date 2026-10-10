#!/usr/bin/env bash
# Punto de entrada del despliegue. GitHub Actions se conecta por SSH con una llave que, en
# authorized_keys, solo puede ejecutar ESTE script (comando forzado):
#
#   command="/opt/eduteka/bin/receive.sh",restrict ssh-ed25519 AAAA… github-actions-deploy
#
# Recibe unicamente el SHA del commit (SSH_ORIGINAL_COMMAND). No recibe codigo: el servidor lo
# descarga el mismo de GitHub (release.sh), asi que una llave robada solo permite desplegar
# commits que ya estan en la rama main del repositorio. Los scripts viven en /opt/eduteka/bin,
# propiedad de root: la llave no puede modificarlos.
set -euo pipefail

SHA="${SSH_ORIGINAL_COMMAND:-}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SHA de commit invalido." >&2
  exit 2
fi

exec /opt/eduteka/bin/release.sh "$SHA"
