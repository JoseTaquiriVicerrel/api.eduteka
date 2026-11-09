# Despliegue en producción

Esquema: **Cloudflare → Nginx → Node (API)**, en un VPS, con MongoDB y Redis. Los archivos de ejemplo están en `deploy/`.

```
App ──HTTPS──▶ Cloudflare ──HTTPS──▶ Nginx (443) ──HTTP local──▶ Node (127.0.0.1:3000)
                 │                      │                           │
        CF-Connecting-IP        real_ip + X-Forwarded-For   TRUST_PROXY=loopback → req.ip
                                                                    ▲
Web ──HTTPS──▶ Cloudflare ──HTTPS──▶ Nginx (443) ──▶ Next ──HTTP local (X-Forwarded-For: visitante)
```

La web (Next) llama a la API **desde su servidor y directo a Node**, nunca por `https://api.eduteka.pe` (ver la sección 4.1).

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
LISTEN_HOST=127.0.0.1            # solo Nginx y Next (mismo servidor) pueden llegar a Node
TRUST_PROXY=loopback             # confia en Nginx y Next por direccion (ver seccion 4)
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

# Simulacros en vivo (socket). El Redis debe ser EL MISMO que usa el monolito: es por donde avisa.
REALTIME_ENABLED=true            # false apaga el socket sin tocar código
REALTIME_PATH=/api/v1/realtime
REALTIME_MAX_CONNECTIONS_PER_USER=5
```

Generar un secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
La lista completa y comentada está en `.env.example`.

## 4. Nginx y Cloudflare

1. `sudo /opt/eduteka/bin/update-cloudflare-ips.sh` (una vez; luego semanal, p. ej. enlazándolo en `/etc/cron.weekly/`).
2. Copiar `deploy/nginx-api.conf` (del repositorio) a `/etc/nginx/conf.d/api.eduteka.pe.conf`, poner el certificado y `sudo nginx -t && sudo systemctl reload nginx`.
3. Cloudflare: SSL/TLS **Full (strict)**, *Always Use HTTPS*, HSTS. Los WebSockets están habilitados por defecto en todos los planes (ver 4.2). La API responde `Cache-Control: no-store` salvo `/api/v1/media/*`.
4. Firewall: abrir solo 22, 80 y 443 (`ufw allow 22,80,443/tcp`; el 3000 queda cerrado). Mejor aún: 80/443 solo para los rangos de Cloudflare.

Por qué `TRUST_PROXY=loopback`: Nginx ya resuelve la IP real con `real_ip` y **sobrescribe** `X-Forwarded-For` con ella, y Next pone ahí la IP del visitante. Los dos llegan a Node desde `127.0.0.1`, así que basta confiar en las conexiones locales: Express revisa `X-Forwarded-For` de derecha a izquierda y toma la primera IP que no es de confianza, que es la del celular o la del visitante de la web. `TRUST_PROXY=1` daría el mismo resultado aquí, pero confía por número de saltos, no por dirección: cualquiera que llegue a Node directamente heredaría la confianza. Si prefieres no usar `real_ip` y dejar `$proxy_add_x_forwarded_for` por defecto, `X-Forwarded-For` traería también la IP de Cloudflare y habría que contar saltos (`TRUST_PROXY=2`), con un firewall que garantice que nadie llegue sin pasar por Cloudflare; eso rompe además la cuenta para la web, que llega con un salto menos.

Comprobación desde fuera: `RateLimit-Remaining` debe **bajar** aunque se cambie la cabecera (Nginx la sobrescribe):

```bash
for i in 1 2 3; do curl -si -H "X-Forwarded-For: 9.9.9.$i" https://api.eduteka.pe/api/v1/config | grep -i ratelimit-remaining; done
```

### 4.1 La web (Next) frente a la API

Next llama a la API desde su servidor con `X-Edk-Client`, el secreto y `X-Forwarded-For: <IP del visitante>`. El límite por IP (en especial el `auth` de `POST /auth/web-exchange`, 10/min) cuenta por esa IP, así que tres cosas tienen que cumplirse:

1. **Next llama directo a Node**, en el `.env` de `eduteka/web`: `EDK_API_URL=http://127.0.0.1:3000`. Si apuntara a `https://api.eduteka.pe`, la llamada pasaría por Cloudflare y por este Nginx, que **sobrescribe** `X-Forwarded-For` con la IP del propio servidor: todos los visitantes de la web compartirían un solo cupo y el puente de sesión fallaría con carga.
2. **La API confía en la dirección de Next:** `TRUST_PROXY=loopback` si están en el mismo servidor.
3. **El Nginx delante de Next también sobrescribe `X-Forwarded-For`.** Next toma la **primera** IP de la cabecera que recibe (`proxy.ts`, `lib/edk-api.ts`); con `$proxy_add_x_forwarded_for` el visitante podría poner cualquier IP delante y saltarse el límite o gastar el de otro. En el `server` de `www.eduteka.pe` (el `include` de Cloudflare va una sola vez en el contexto `http`):

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3100;
       proxy_set_header Host            $host;
       proxy_set_header X-Forwarded-For $remote_addr;   # SOBRESCRIBE: $remote_addr ya es la IP real (real_ip)
       proxy_set_header X-Real-IP       $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

**Si Next corre en otro servidor** (p. ej. `10.0.0.5` en la red privada): `LISTEN_HOST=<IP privada de la API>`, `TRUST_PROXY=loopback, 10.0.0.5`, `EDK_API_URL=http://<IP privada de la API>:3000`, y el firewall abre el 3000 **solo** para `10.0.0.5`. Nunca `uniquelocal` entero ni un número de saltos: cualquier equipo de la red podría falsear su IP.

Comprobación desde el servidor: cada IP debe tener **su propio** contador (`RateLimit-Remaining` no baja entre IPs distintas):

```bash
for i in 1 2 3; do curl -si -H "X-Forwarded-For: 9.9.9.$i" http://127.0.0.1:3000/api/v1/config | grep -i ratelimit-remaining; done
```

### 4.2 Simulacros en vivo (socket)

El socket (`/api/v1/realtime/`) es Socket.IO sobre WebSocket. Tres cosas tienen que cumplirse:

1. **Nginx:** el `location /api/v1/realtime/` de `deploy/nginx-api.conf` (con `Upgrade`, `Connection "upgrade"` y lectura de 3600 s) va **antes** de `location /`. El `location /` manda `Connection ""` y cortaría el WebSocket. Tras copiarlo: `sudo nginx -t && sudo systemctl reload nginx`.
2. **Cloudflare:** WebSocket viene activo en todos los planes; confirma SSL/TLS **Full (strict)**. Si se corta cada ~100 s revisa que no haya una regla de *proxy read timeout* ajena.
3. **Redis compartido:** la API se suscribe al canal `edk:simulacrum:events`, por donde el monolito publica cada hito (cierre, inicio, fin, resultados). Sin Redis (o con otro Redis distinto) el socket arranca igual, pero **no llega ningún aviso**: los clientes caen al sondeo de 30 s. En el arranque la API lo avisa en el log (`Sin Redis: la API no recibira avisos del monolito…`).

Con una sola instancia no hacen falta *sticky sessions* ni el adaptador de Redis de Socket.IO. Si algún día hay varias, cada una se suscribe al mismo canal y emite a **sus** sockets; solo falta *sticky sessions* en el balanceador para el *polling*.

La web (Next) llama a Node directo (4.1) y no pasa por este bloque; el **navegador** y la app sí pasan por `api.eduteka.pe`.

**Orden de despliegue:** (1) API con los endpoints de simulacros programados (compatible con las apps actuales); (2) Nginx con el `location` del socket; (3) API con el socket y el monolito publicando la señal, en cualquier orden — sin suscriptor la señal se pierde sin daño y sin publicador solo faltan los avisos.

**Comprobación del socket** (Engine.IO debe abrir con `200` y un cuerpo que empieza por `0{"sid"`, lo que prueba que la ruta llega a Node; el rechazo sin token llega al unirse al namespace):

```bash
curl -si "https://api.eduteka.pe/api/v1/realtime/?EIO=4&transport=polling" | head -3
node scripts/realtime_watch.mjs https://api.eduteka.pe <slug> <access_token>
```

La prueba de punta a punta con el monolito está en `docs/prueba-e2e-simulacros-en-vivo.md`.

## 5. Servicio (systemd)

`deploy/eduteka-api.service` → `/etc/systemd/system/` (paso *c* de la sección 2). Ejecuta la versión activa (`/opt/eduteka/current`), reinicia solo si se cae, limita los reinicios fallidos, apaga ordenadamente con SIGTERM y deja el disco en solo lectura salvo `/var/lib/eduteka`, donde están los datos.

```bash
sudo systemctl enable --now eduteka-api
journalctl -u eduteka-api -f
```

Un solo proceso es suficiente: el rate limit y los bloqueos de login están en Redis. **Redis debe estar siempre arriba**: si cae, `/health` responde 503 y cada proceso cuenta los límites por su cuenta.

### 5.1 Colas (BullMQ) y procesos de fondo

Plan de separación de servicios, Fase 0 (`eduteka/docs/plan-separacion-servicios-2026-11.md`). Las colas viven en una **segunda instancia de Redis**, porque la caché necesita expulsar claves y una cola no puede perder trabajos.

| Instancia | Puerto | `maxmemory-policy` | Para qué |
|---|---|---|---|
| Redis actual (caché) | 6379 | `volatile-lru` | caché, sesiones técnicas, contadores, pub/sub `edk:*` |
| `redis-queue` | 6380 | `noeviction` | colas BullMQ (prefijo `edk:q`) |

**1. Auditar el Redis actual** (solo lectura):

```bash
REDIS_PASSWORD=... deploy/redis-audit.sh
```

Revisa que `maxmemory` no sea `0` y mira las claves **sin TTL** del final: `volatile-lru` nunca las expulsa.

**2. Fijar la política de la caché** (en su `redis.conf`, y en caliente):

```bash
redis-cli -a "$REDIS_PASSWORD" CONFIG SET maxmemory 512mb
redis-cli -a "$REDIS_PASSWORD" CONFIG SET maxmemory-policy volatile-lru
redis-cli -a "$REDIS_PASSWORD" CONFIG REWRITE
```

**3. Instalar `redis-queue`**: los pasos están en la cabecera de `deploy/redis-queue.service`. Cambia `requirepass` en `/etc/redis/redis-queue.conf` y pon la misma clave en `QUEUE_REDIS_PASSWORD`.

**4. Activar el worker**: en `/opt/eduteka/shared/.env`, `QUEUE_ENABLED=true` y `QUEUE_REDIS_*`; después:

```bash
sudo install -m 440 deploy/sudoers-deploy /etc/sudoers.d/eduteka-deploy   # permite reiniciar eduteka-worker
sudo cp deploy/eduteka-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now eduteka-worker
curl -s http://127.0.0.1:3003/health
```

`deploy/release.sh` reinicia `eduteka-worker` después de la API **solo si está habilitado**, y vuelve a la versión anterior si su `/health` no responde.

**5. Comprobar de extremo a extremo** (desde `/opt/eduteka/current`, como `eduteka`):

```bash
QUEUE_ENABLED=true node scripts/queue_ping.js
```

Para comprobar que un trabajo sobrevive a un reinicio: `sudo systemctl stop eduteka-worker`, lanza `node scripts/queue_ping.js --wait=60` y, mientras espera, `sudo systemctl start eduteka-worker`. La respuesta tiene que llegar.

El Redis de colas **no se respalda**: solo transporta trabajos; la verdad de negocio está en Mongo.

### 5.2 Simulacros en vivo fuera del monolito (Fase 1)

Tres procesos del mismo código sustituyen al reloj y al socket del monolito:

| Unidad | Qué hace | `/health` |
|---|---|---|
| `eduteka-scheduler` | Hitos de cada simulacro programado (trabajos diferidos en la cola `simulacrum`), `reconcile` cada 5 min y cierre de la ventana | `127.0.0.1:3004` |
| `eduteka-worker` | Califica cada intento abierto al cerrar (cola `simulacrum-grading`) con el mismo cierre que `finalizar` | `127.0.0.1:3003` |
| `eduteka-realtime` | El único socket.io: app y Next (Bearer) y páginas SSR del monolito (cookie, validada en el monolito) | `127.0.0.1:3002` |

**Los dos relojes nunca a la vez.** El monolito tiene el interruptor `SIMULACRUM_CLOCK`: `monolith` (por defecto, como hoy) o `external`. Corta **fuera de una ventana**: sin simulacros programados que empiecen o terminen en las próximas 24 h.

**Corte**

1. Colas activas (§5.1) y `eduteka-worker` habilitado.
2. En `/opt/eduteka/shared/.env`: `REALTIME_ENABLED=false` (la API HTTP deja de abrir su socket) y `MONOLITH_URL` definido (lo usa la cookie del socket).
3. Instalar y habilitar `eduteka-scheduler` y `eduteka-realtime` (copiar las unidades de `deploy/`, `daemon-reload`, `enable --now`), reinstalar `deploy/sudoers-deploy` y reiniciar `eduteka-api`.
4. Nginx de la API: `deploy/nginx-api.conf` ya manda `/api/v1/realtime/` al upstream `eduteka_realtime` (3002). `nginx -t && systemctl reload nginx`.
5. Nginx de la web (`eduteka.pe`): el socket de las páginas SSR va por el mismo origen, para que viaje la cookie. Agregar, **antes** de `location /`:

   ```nginx
   location /api/v1/realtime/ {
       proxy_pass http://127.0.0.1:3002;
       proxy_http_version 1.1;
       proxy_set_header Upgrade    $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host              $host;
       proxy_set_header X-Real-IP         $remote_addr;
       proxy_set_header X-Forwarded-For   $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;
       proxy_send_timeout 3600s;
       proxy_buffering    off;
   }
   ```

6. En el `.env` del monolito: `SIMULACRUM_CLOCK=external` y reiniciarlo. Al arrancar escribe `SIMULACRUM_CLOCK=external: el reloj de simulacros corre en edk-scheduler`.
7. Comprobar: los tres `/health` en 200 y, con un simulacro gratis de prueba, los criterios de `docs/spec-simulacros-en-vivo-0-contrato.md` §12 desde la app y desde la web.

**Vuelta atrás**: `SIMULACRUM_CLOCK=monolith` en el monolito y reiniciarlo, `systemctl disable --now eduteka-scheduler eduteka-realtime`, `REALTIME_ENABLED=true` en la API y quitar el `location` de `eduteka.pe`. Al arrancar, el monolito reconcilia y retoma lo pendiente.

**Varias réplicas**: el scheduler no necesita líder (los hitos tienen id determinista y todo es idempotente). En realtime, cada réplica escucha el bus y emite a sus propios sockets; con transporte *polling* hace falta `ip_hash` en el upstream.

### 5.3 Documentos fuera del monolito (Fase 2)

`eduteka-docs` imprime los PDF (listas, exámenes, compendios) con **un solo Chromium** compartido y convierte el Word del material con LibreOffice. El monolito sigue armando el HTML (plantillas e imágenes incrustadas) y lo deja en el almacenamiento de objetos; por la cola solo viajan claves. El PDF vuelve por el mismo almacenamiento con una clave que es el hash del contenido: un documento ya impreso no se vuelve a imprimir.

| Interruptor (monolito) | Valores |
|---|---|
| `DOCS_RENDERER` | `local` (por defecto, como hoy: Chromium en el proceso web) o `service` (edk-docs) |
| `DOCS_FALLBACK_LOCAL` | `true` por defecto: si edk-docs o el Redis de colas no responden, se imprime en el proceso web |
| `DOCS_WAIT_MS` | Espera máxima por documento (120 s) |

**Corte**

1. Paquetes del sistema: `sudo apt install chromium-browser libreoffice-writer` (y las fuentes de las plantillas Word).
2. **Almacenamiento compartido**: en disco, el mismo `OBJECT_STORAGE_DIR` en la API y en el monolito (p. ej. `/var/lib/eduteka/objects`, con permisos de escritura para los dos usuarios); o `STORAGE_DRIVER=r2` con las mismas credenciales en ambos.
3. En `/opt/eduteka/shared/.env`: `DOCS_CHROMIUM_PATH=/usr/bin/chromium-browser`. Instalar `deploy/eduteka-docs.service`, `enable --now`, reinstalar `deploy/sudoers-deploy`. `curl -s http://127.0.0.1:3005/health`.
4. En el `.env` del monolito: `QUEUE_REDIS_*` (las mismas que la API), `OBJECT_STORAGE_DIR` o `R2_*`, y `DOCS_RENDERER=service`. Reiniciar el monolito.
5. Comprobar: descargar el PDF de una lista, el de un examen desde el panel y la vista previa de un material. En el log de `eduteka-docs` aparece `PDF impreso` / `DOCX convertido a PDF`.

**Vuelta atrás**: `DOCS_RENDERER=local` en el monolito y reiniciarlo.

**Limpieza pendiente**: los PDF impresos quedan en `pdf/print/` y `pdf/docx/` del almacenamiento. En R2, una regla de ciclo de vida (p. ej. 30 días) sobre esos prefijos; en disco, todavía no hay poda automática.

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
- [ ] `NODE_ENV=production`, `TRUST_PROXY=loopback`, `LISTEN_HOST=127.0.0.1`, puerto 3000 cerrado.
- [ ] Prueba de `X-Forwarded-For` falso (sección 4) y contadores por IP desde el servidor (sección 4.1).
- [ ] Web: `EDK_API_URL` apunta a Node (`http://127.0.0.1:3000`) y el Nginx de `www` sobrescribe `X-Forwarded-For`.
- [ ] Socket de simulacros: `location /api/v1/realtime/` en Nginx, mismo Redis que el monolito y `scripts/realtime_watch.mjs` recibe los eventos (4.2).
- [ ] `PAYMENT_YAPE_HOLDER` o `PAYMENT_YAPE_NUMBER` definido; prueba con un comprobante real.
- [ ] Respaldo ejecutado y restauración probada.
- [ ] *(cuando actives CI/CD)* Secretos de GitHub, llave con comando forzado y primer despliegue manual verificado; `rollback.sh` probado una vez.
- [ ] `npm audit --omit=dev` revisado.
