# Despliegue en producción

Esquema: **Cloudflare → Nginx → Node (API)**, en un VPS, con MongoDB y Redis. Los archivos de ejemplo están en `deploy/`.

```
App ──HTTPS──▶ Cloudflare ──HTTPS──▶ Nginx (443) ──HTTP local──▶ Node (127.0.0.1:3000)
                 │                      │                           │
        CF-Connecting-IP        real_ip + X-Forwarded-For      TRUST_PROXY=1 → req.ip
```

## 1. Requisitos

- **Node 24 LTS** (`.nvmrc`; mínimo `>=22`). Instalar con NodeSource, `nvm` o `fnm`, no con el paquete de la distribución.
- MongoDB (la misma base del monolito, con un **usuario propio de la API** y permisos mínimos) y Redis con contraseña.
- Usuario del sistema sin login: `sudo useradd --system --home /opt/eduteka eduteka`.

## 2. Despliegue continuo (GitHub Actions → VPS)

> **Estado: preparado, pero desactivado.** `ci.yml` y `deploy.yml` existen en el repositorio y solo se ejecutan a mano
> (Actions → *Run workflow*); nada corre en los push. El servidor tampoco necesita nada hasta que lo actives: ver
> [Activar CI/CD](#activar-cicd) al final de esta sección.

Una vez activado, cada push a `main` con `test` y `audit` en verde despliega solo. El flujo (`.github/workflows/deploy.yml`):

```
push a main ─▶ lint + tests + audit ─▶ SSH al VPS (solo envía el SHA del commit)
                                                      │
              el servidor descarga ese commit de GitHub y comprueba que está en main
                                                      │
   /health público ◀─ activa la versión nueva ◀─ prueba de arranque ◀─ npm ci --omit=dev
        │                         │ si no responde
        ▼                         ▼
   despliegue OK            vuelve solo a la versión anterior
```

**El código no se sube: el servidor lo trae de GitHub.** Actions solo avisa qué commit desplegar. Así, una llave de despliegue robada únicamente permite desplegar commits que ya están en `main`, nunca código arbitrario. Tampoco se hace `git pull` sobre la versión en servicio: cada versión se extrae con `git archive` en su propia carpeta, para que `npm ci` no deje la API a medias mientras corre.

Qué hace el servidor (`deploy/release.sh`):

1. Hace `git fetch` de `main` a su clon local (`/opt/eduteka/repo.git`) y comprueba que el commit existe y **pertenece a `main`**; si GitHub no responde, aborta sin tocar nada. Extrae ese commit en `/opt/eduteka/releases/<fecha>-<sha>/` (sin tests, docs ni `deploy/`, por `.gitattributes`) y ejecuta `npm ci --omit=dev` **ahí** (la versión en servicio no se toca mientras tanto; `bcrypt` se instala para la arquitectura del servidor).
2. **Prueba de arranque:** levanta la versión nueva en `127.0.0.1:3101` con el `.env` real y exige `/health` en `ok` (Mongo y Redis arriba). Si falla, borra esa versión y el despliegue termina en error; la vigente sigue sirviendo.
3. Cambia el enlace `current` de forma atómica y reinicia el servicio (`systemctl restart`). Hay un corte de 1 a 3 segundos: con una sola instancia es inevitable.
4. Espera `/health` en `ok`. Si no llega, **vuelve a la versión anterior** y falla el despliegue.
5. Conserva las últimas 5 versiones.

Los datos (`/var/lib/eduteka`) y el `.env` (`/opt/eduteka/shared`) están fuera de las versiones: un despliegue no los toca.

### Configuración inicial (una sola vez)

**a) Usuarios y carpetas.** `deploy` despliega el código; `eduteka` lo ejecuta y es el único que escribe datos.

```bash
sudo useradd --system --create-home --shell /bin/bash deploy
sudo useradd --system --no-create-home --shell /usr/sbin/nologin eduteka   # si no existe ya

# /opt/eduteka es de root con el bit "sticky" (1775): `deploy` puede crear ahí repo.git y el enlace
# `current`, pero NO puede renombrar ni borrar lo que es de root (bin/, shared/), es decir, no puede
# sustituir los scripts que ejecuta su propia llave.
sudo install -d -o root -g deploy -m 1775 /opt/eduteka
sudo install -d -o deploy  -g deploy   -m 755 /opt/eduteka/releases
sudo install -d -o root    -g root     -m 755 /opt/eduteka/bin /opt/eduteka/shared
sudo apt-get install -y git                                           # si no está
sudo install -d -o eduteka -g eduteka  -m 750 /var/lib/eduteka /var/lib/eduteka/storage /var/lib/eduteka/pay_capture
```

**b) Variables de producción** en `/opt/eduteka/shared/.env` (ver sección 3). El dueño es `root`, el grupo `eduteka`, permisos 640: el servicio la lee y `deploy` solo la enlaza.

```bash
sudo install -o root -g eduteka -m 640 .env /opt/eduteka/shared/.env
```

Con los datos fuera del código, define en ese `.env`:

```env
STORAGE_DIR=/var/lib/eduteka/storage
PAY_CAPTURE_DIR=/var/lib/eduteka/pay_capture
FILES_ROOT_DIR=/var/lib/eduteka
```

Si ya tienes datos en otra ruta (por ejemplo `/opt/eduteka/api/storage`), **muévelos antes** a `/var/lib/eduteka/storage` y ajusta estas tres variables; `FILES_ROOT_DIR` debe seguir siendo la carpeta que contiene a `STORAGE_DIR`, porque las rutas de archivos de la base se resuelven contra ella.

**c) Scripts del servidor.** Se instalan una vez en `/opt/eduteka/bin`, propiedad de `root`, para que la llave de despliegue no pueda modificarlos. Si cambian en el repo, hay que volver a copiarlos.

```bash
sudo install -o root -g root -m 755 deploy/receive.sh deploy/release.sh deploy/rollback.sh deploy/backup.sh deploy/update-cloudflare-ips.sh /opt/eduteka/bin/
sudo visudo -cf deploy/sudoers-deploy && sudo install -m 440 deploy/sudoers-deploy /etc/sudoers.d/eduteka-deploy
sudo cp deploy/eduteka-api.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable eduteka-api
```

**d) Llave SSH exclusiva para desplegar.** Se genera en tu máquina (no en el servidor) y nunca se reutiliza:

```bash
ssh-keygen -t ed25519 -f deploy_key -C "github-actions-deploy" -N ""
```

En el servidor, `/home/deploy/.ssh/authorized_keys` (permisos 600) con **una sola línea**: la llave pública, atada al script. Con `command=` y `restrict`, quien tenga la llave solo puede indicar un SHA a `receive.sh`; no obtiene una terminal ni puede abrir túneles.

```
command="/opt/eduteka/bin/receive.sh",restrict ssh-ed25519 AAAA…tu_llave_publica… github-actions-deploy
```

**e) Acceso del servidor a GitHub (solo lectura).** Otra llave, distinta de la anterior, para que el servidor descargue el código:

```bash
sudo -u deploy ssh-keygen -t ed25519 -f /home/deploy/.ssh/github_deploy -C "vps-eduteka-readonly" -N ""
sudo -u deploy cat /home/deploy/.ssh/github_deploy.pub        # copia la línea
```

En GitHub: repositorio → Settings → **Deploy keys** → Add deploy key → pega la pública y **deja sin marcar "Allow write access"**. Luego fija la huella de GitHub en el servidor, comprobándola contra la oficial en https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints:

```bash
sudo -u deploy sh -c 'ssh-keyscan -t ed25519 github.com >> /home/deploy/.ssh/known_hosts'
sudo -u deploy ssh-keygen -lf /home/deploy/.ssh/known_hosts          # compara la huella SHA256
sudo -u deploy GIT_SSH_COMMAND="ssh -i ~/.ssh/github_deploy -o IdentitiesOnly=yes" git ls-remote git@github.com:JoseTaquiriVicerrel/api.eduteka.git HEAD   # debe listar el HEAD
```

`release.sh` clona el repositorio la primera vez (`REPO_URL` y `BRANCH` se pueden cambiar con variables de entorno).

**f) Secretos en GitHub** (Settings → Environments → `production` → Environment secrets):

| Secreto | Valor |
|---|---|
| `DEPLOY_HOST` | IP o dominio del VPS (el SSH debe ser directo, no pasar por Cloudflare) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | Puerto SSH (opcional, 22 por defecto) |
| `DEPLOY_SSH_KEY` | Contenido **completo** del archivo `deploy_key` (privada) |
| `DEPLOY_KNOWN_HOSTS` | Salida de `ssh-keyscan -t ed25519 TU_HOST`, **comprobando antes la huella** con `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` en el servidor |

Después borra `deploy_key` de tu equipo. En el mismo entorno `production` conviene activar **Required reviewers**: cada despliegue espera a que lo apruebes.

**g) Primer despliegue.** Haz un push a `main` (o ejecuta el workflow). En el primer arranque `current` aún no existe: es normal, `release.sh` lo crea. Comprueba:

```bash
ls -l /opt/eduteka/                       # current -> releases/…
systemctl status eduteka-api
curl -s https://api.eduteka.pe/api/v1/health
```

### Activar CI/CD

Mientras no hagas esto, el despliegue es manual (copiar el código y reiniciar como hasta ahora) y GitHub no ejecuta nada.

1. **Prepara el servidor y los secretos** (pasos *a* a *f* de la configuración inicial). Haz un primer despliegue **a mano** para comprobarlo todo: *Actions → Deploy → Run workflow*. Es seguro: solo se ejecuta si lo lanzas tú, y el entorno `production` puede pedirte aprobación.
2. **Activa el CI** en `.github/workflows/ci.yml`: borra la línea `workflow_dispatch:` y descomenta `push:` y `pull_request:`. A partir de ahí cada push y pull request ejecuta lint, pruebas y auditoría.
3. **Activa el despliegue automático** en `.github/workflows/deploy.yml`: descomenta el bloque `workflow_run` (se dispara cuando el CI termina bien en `main`). Puedes dejar `workflow_dispatch:` para poder desplegar a mano o reintentar.
4. **Recomendado:** en GitHub, Settings → Branches, protege `main` (exigir que pase el CI antes de fusionar) y en Settings → Environments → `production` activa *Required reviewers* para aprobar cada despliegue.

Para volver a apagarlo basta con deshacer los pasos 2 y 3 (o desactivar el workflow en Actions); no hay nada que desinstalar del servidor.

### Volver atrás a mano

Si una versión pasa el `/health` pero tiene un fallo de negocio:

```bash
ls /opt/eduteka/releases                                  # versiones disponibles
sudo -u deploy /opt/eduteka/bin/rollback.sh               # la inmediatamente anterior
sudo -u deploy /opt/eduteka/bin/rollback.sh 20261009-1530-abc1234   # una concreta
```

No reconstruye nada: cambia el enlace y reinicia (unos segundos). Para que quede definitivo, revierte el commit en `main` con `git revert`; si no, el próximo push desplegará de nuevo el cambio.

### Qué no hace (y alternativas)

- **Cero corte:** con una sola instancia hay 1 a 3 s de reinicio. Cloudflare y la app reintentan; si algún día importa, se corren dos instancias en puertos distintos detrás del `upstream` de Nginx y se reinician de una en una.
- **Migraciones de datos:** la API no crea índices ni migra la base (es del monolito), así que el despliegue no incluye ese paso.
- **Si GitHub está caído:** el despliegue falla antes de tocar nada y la versión vigente sigue sirviendo.
- **Cambios en `deploy/`:** los scripts del servidor no se actualizan solos (es a propósito: así la llave de despliegue no puede cambiarlos). Tras modificarlos, repite el paso *c*.

## 3. Variables de producción (`/opt/eduteka/shared/.env`, root:eduteka, 640)

```env
NODE_ENV=production
PORT=3000
LISTEN_HOST=127.0.0.1            # solo Nginx puede llegar a Node
TRUST_PROXY=1                    # un salto: Nginx (ver nginx-api.conf)
API_CORS_ORIGINS=                # vacía: solo la usa la app móvil
PUBLIC_API_URL=https://api.eduteka.pe
LOG_LEVEL=info

JWT_SECRET=<48+ caracteres aleatorios, DISTINTO de JWT_PRIVATE_KEY del monolito>
BCRYPT_ROUNDS=12
MONGODB_URI=<usuario propio de la API>
REDIS_HOST=… REDIS_PORT=… REDIS_PASSWORD=…

PAYMENT_YAPE_HOLDER=<titular tal como lo muestra Yape>
PAYMENT_YAPE_NUMBER=…
PAYMENT_REQUIRE_RECEIVER_MATCH=true
PAYMENT_AUTO_APPROVE_MAX_AMOUNT=<soles; 0 = sin límite>
```

Generar un secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
La lista completa y comentada está en `.env.example`.

## 4. Nginx y Cloudflare

1. `sudo /opt/eduteka/bin/update-cloudflare-ips.sh` (una vez; luego semanal, p. ej. enlazándolo en `/etc/cron.weekly/`).
2. Copiar `deploy/nginx-api.conf` (del repositorio) a `/etc/nginx/conf.d/api.eduteka.pe.conf`, poner el certificado y `sudo nginx -t && sudo systemctl reload nginx`.
3. Cloudflare: SSL/TLS **Full (strict)**, *Always Use HTTPS*, HSTS. La API responde `Cache-Control: no-store` salvo `/api/v1/media/*`.
4. Firewall: abrir solo 22, 80 y 443 (`ufw allow 22,80,443/tcp`; el 3000 queda cerrado). Mejor aún: 80/443 solo para los rangos de Cloudflare.

Por qué `TRUST_PROXY=1` y no `2`: Nginx ya resuelve la IP real con `real_ip` y **sobrescribe** `X-Forwarded-For` con ella, así que a Node solo le llega un proxy delante. Si prefieres no usar `real_ip` y dejar `$proxy_add_x_forwarded_for` por defecto, serían dos saltos (`TRUST_PROXY=2`), pero entonces el firewall debe garantizar que nadie llegue al servidor sin pasar por Cloudflare.

Comprobación: `RateLimit-Remaining` debe **bajar** aunque se cambie la cabecera:

```bash
for i in 1 2 3; do curl -si -H "X-Forwarded-For: 9.9.9.$i" https://api.eduteka.pe/api/v1/config | grep -i ratelimit-remaining; done
```

## 5. Servicio (systemd)

`deploy/eduteka-api.service` → `/etc/systemd/system/` (paso *c* de la sección 2). Ejecuta la versión activa (`/opt/eduteka/current`), reinicia solo si se cae, limita los reinicios fallidos, apaga ordenadamente con SIGTERM y deja el disco en solo lectura salvo `/var/lib/eduteka`, donde están los datos.

```bash
sudo systemctl enable --now eduteka-api
journalctl -u eduteka-api -f
```

Un solo proceso es suficiente: el rate limit y los bloqueos de login están en Redis. **Redis debe estar siempre arriba**: si cae, `/health` responde 503 y cada proceso cuenta los límites por su cuenta.

## 6. Respaldos

`/opt/eduteka/bin/backup.sh` (copia de `deploy/backup.sh`; lee el `.env`, así que corre como `root`) guarda Mongo, los comprobantes de pago y los avatares (no la caché de fórmulas, que se regenera).

```cron
30 3 * * *  REMOTE="rclone:b2:eduteka-backups"  /opt/eduteka/bin/backup.sh >> /var/log/eduteka-backup.log 2>&1
```

Sin `REMOTE` el respaldo queda en el mismo disco: no protege de un fallo del servidor. **Prueba una restauración** al menos una vez (`mongorestore --archive=… --gzip`).

## 7. Integración continua

`.github/workflows/ci.yml` ejecuta `npm run lint`, `npm test` y `npm audit --omit=dev --audit-level=critical`. **Hoy está desactivado** (solo a mano); para que corra en cada push y pull request, ver *Activar CI/CD* en la sección 2. Mientras tanto puedes ejecutar lo mismo en local con `npm run lint && npm test`. Las vulnerabilidades *altas* se revisan a mano porque algunas piden saltos de versión mayores.

## 8. Lista de comprobación antes de abrir al público

- [ ] `/health` → `ok` (mongo y redis arriba).
- [ ] `JWT_SECRET` ≠ `JWT_PRIVATE_KEY`, y claves de Cloudinary/otros que se hayan filtrado, rotadas.
- [ ] `NODE_ENV=production`, `TRUST_PROXY=1`, `LISTEN_HOST=127.0.0.1`, puerto 3000 cerrado.
- [ ] Prueba de `X-Forwarded-For` falso (sección 4).
- [ ] `PAYMENT_YAPE_HOLDER` o `PAYMENT_YAPE_NUMBER` definido; prueba con un comprobante real.
- [ ] Respaldo ejecutado y restauración probada.
- [ ] *(cuando actives CI/CD)* Secretos de GitHub, llave con comando forzado y primer despliegue manual verificado; `rollback.sh` probado una vez.
- [ ] `npm audit --omit=dev` revisado.
