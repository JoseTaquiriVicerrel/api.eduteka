# Spec: generar los SVG de fórmulas al agregar un examen o simulacro

Estado: propuesta (2026-11-07). Afecta al monolito (`E:\Trabajo\eduteka`, donde se crean/verifican exámenes y simulacros) y a la API (`E:\Trabajo\api_eduteka`, que genera y sirve los SVG). Contexto: `api_eduteka/docs/api-latex-svg-plan.md`.

## 1. Problema

1. **Tablas y entornos sueltos sin SVG (corregido).** El banco guarda algunas tablas como `<p>\begin{array}{|c|c|}\hline … \end{array}</p>` **sin** `\[ \]`. La web las pinta (MathJax procesa `\begin{..}` suelto) pero `extractFormulas` (`api_eduteka/src/libs/math_svg.js`) solo buscaba delimitadores, así que la API las dejaba como texto y la app mostraba `\begin{array} {|c|c|}\hline …` crudo (preguntas de Estequiometría de la captura). Ahora `extractFormulas` reconoce también `array`, `matrix` (y `p/b/v/B/Vmatrix`), `smallmatrix`, `cases`, `align(ed)`, `gather(ed)`, `split`, `eqnarray`, `equation`, `multline` (con o sin `*`) sin delimitadores, como bloque. Pruebas en `test/math_svg.test.js`.
2. **Un examen o simulacro nuevo no tiene sus SVG.** Los SVG se generan al vuelo con un presupuesto de 5 s por petición (`?math=svg`); lo que no alcanza a convertirse sale en LaTeX y "se completa en las siguientes peticiones". El primer estudiante de un simulacro nuevo ve LaTeX crudo. Hoy el precalentamiento (`npm run math:warm`) es manual.

## 2. Requisito

Cuando un examen se **verifica** o un simulacro se **publica/verifica** (o cambia su contenido estando publicado), sus fórmulas deben quedar convertidas y en caché **antes** de que lo abra un estudiante, sin intervención manual y sin bloquear al administrador.

## 3. Diseño

### 3.1 Script (ya existe; se amplía)

`api_eduteka/scripts/warm_math_cache.js` es idempotente y solo convierte lo que falta.

| Opción | Uso |
|---|---|
| `--slug=<simulacro>` | solo ese simulacro (incluye lo que el intento sirve, también en los de prospecto) |
| `--exam=<id>` | **nuevo**: solo ese examen |
| sin opciones | todo el banco (backfill, p. ej. tras cambiar `MATH_TEMPLATE_VERSION` o el extractor) |

Salida `--failures=ruta.csv` y `--strict` (exit 1) para ver las fórmulas que MathJax rechaza (TeX inválido en el banco: también se verían mal en la web).

### 3.2 Disparador: señal por Redis (recomendado)

Reutiliza el bus que ya existe entre el monolito y la API (`edk:simulacrum:events`, `libs/simulacrum_signal.js` / `simulacrum.events.js`), que no lleva datos de negocio y nunca bloquea el hito.

1. **Monolito**: al guardar con `verified = true` un examen o simulacro (controladores de admin de `exam` y `simulacrum`, y al terminar `process_question_add` / edición de preguntas de uno ya verificado), publicar `{ v: 1, type: 'content', kind: 'exam'|'simulacrum', id, slug, emitted_at }` en un canal nuevo `edk:content:events` (o añadir el tipo `content` a `SIGNAL_TYPES`). Mismo contrato: falla en silencio, cliente en memoria no publica.
2. **API**: un suscriptor (como `simulacrum.events.js`) recibe la señal y encola el precalentamiento de ese documento con `collectFormulas({ slug | exam })` + `warmFormulas`. Cola de 1 trabajo a la vez, deduplicada por `kind:id`, con la misma cola de concurrencia de MathJax (el trabajo corre en el worker, no en el event loop).
3. Al terminar, `logger.info` con convertidas / nuevas / fallidas; las fallidas se registran con el id de la pregunta.

Notas de la revisión: (a) la señal debe publicarse **después** de guardar en Mongo, o la API leería el documento anterior; (b) en un simulacro la API solo precalienta si `verified && state` (publicado), así que al verificar uno aún en borrador no hace nada y hay que volver a emitir al publicarlo; (c) con varias instancias de la API cada una recibe la señal y convierte (es idempotente y el SVG va a disco compartido, solo se duplica la lectura).

Fallback si no hay Redis (dev) o la señal se pierde: el presupuesto de 5 s sigue funcionando y la tarea programada de §3.3 lo cubre.

### 3.3 Red de seguridad

- Tarea periódica en el servidor de la API (p. ej. cron cada hora, `npm run math:warm`): idempotente, cuesta ~3 s de lectura si no hay nada nuevo (medido: 195 000 fragmentos, 10 559 documentos).
- Paso de despliegue: `npm run math:warm` después de cada deploy que cambie `math_svg.js`, `math_render.js` o `MATH_TEMPLATE_VERSION`; luego `npm run math:prune`.

### 3.4 Alternativa descartada

Que el monolito ejecute `node ../api_eduteka/scripts/warm_math_cache.js` con `child_process`: acopla los dos repos, exige que compartan disco (`STORAGE_DIR`) y bloquea o duplica el trabajo si hay varias instancias.

## 4. Pruebas

- API: `test/math_svg.test.js` (entornos sueltos: array real del banco, anidado, dentro de `\[ \]`, sin cierre, escapado, en atributo/`<code>`); `test/math_warm.test.js` ampliar con `--exam`.
- API: una señal `content` de un simulacro de prospecto deja en caché las fórmulas de las preguntas que `loadQuestionSet` sirve.
- Monolito: al verificar un examen se llama a `publishSignal` una vez; sin Redis no lanza.
- Manual: simulacro nuevo con un `array` sin delimitadores → `GET /simulacros/:slug/solucionario?math=svg` sin `\begin` ni `\[` en el HTML y el primer abrir no supera 1 s.

## 5. Hecho en esta sesión

- [x] `extractFormulas` reconoce entornos sin delimitadores (`api_eduteka/src/libs/math_svg.js`) + 5 pruebas; 103/103 pruebas de fórmulas pasan.
- [x] `warm_math_cache.js --exam=<id>`.
- [x] Backfill ejecutado en este equipo: +506 fórmulas nuevas convertidas (15 315 SVG, 80,7 MB en total). **Pendiente repetirlo en producción** (`npm run math:warm`) tras desplegar el cambio.
- [x] **API** (§3.2): `src/libs/content_events.js` (canal `edk:content:events`, valida el contrato, Redis aparte en modo suscriptor, bus local sin Redis) y `src/libs/math_prewarm.js` (cola de 1 trabajo, deduplicada por `kind:id`; omite lo no verificado/publicado; registra convertidas/nuevas/fallidas con el id de origen). Arranca en `server.js` con `MATH_PREWARM_ENABLED` (por defecto `true`). `collectFormulas` acepta `simulacrum: <id>`. Pruebas en `test/math_prewarm.test.js` (incluye simulacro de prospecto y tablas sin delimitadores).
- [ ] **Monolito**: publicar la señal `content` en `edk:content:events` (§3.2 punto 1). Sin esto la API no recibe nada.
- [ ] Cron de respaldo en el servidor (§3.3): `0 * * * * cd /ruta/api_eduteka && npm run math:warm`.

## 6. Fórmulas que siguen fallando (datos del banco, no del convertidor)

`warm_math_cache.js` deja 101 fórmulas sin convertir (lista en `api_eduteka/storage/math_failures.csv`). Son del contenido y se ven mal también en la web: letras con tilde o `µ` fuera de `\text{}` (`MÁX.`, `máx`, `días`) y TeX roto (`\begin{array}` con llaves sin cerrar). Se corrigen en el banco; el convertidor las deja en LaTeX a propósito (un `<text>` depende de la fuente del dispositivo).
