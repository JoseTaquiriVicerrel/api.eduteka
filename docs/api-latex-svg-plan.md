# Plan para `api_eduteka`: fórmulas LaTeX como SVG

Estado: propuesta revisada (2026-10-02) tras contrastarla con el código. Cambios respecto a la primera versión: worker para MathJax (§3.1), caché de metadatos en memoria (§3.1), integración por capa de respuesta en vez de serializadores `async` (§3.4), paso 0 de spike (§4), D3 como requisito previo (§8) y riesgos nuevos (§9).

## 1. Objetivo y alcance

Hoy la API entrega el HTML de las preguntas con LaTeX tal cual (`\[ … \]`, `\( … \)`, `$$ … $$`) y la app lo pinta con KaTeX dentro de un WebView. La propuesta: que la API sustituya cada fórmula por una `<img>` que apunta a un SVG generado con MathJax, para que la app lo pinte todo nativo (Coil) y se elimine el WebView.

**Reglas que no se negocian**
- El campo `question` / `options` / `resolution` / `dependence` de la base **no se modifica**. El LaTeX sigue siendo la fuente de verdad (el monolito y la web dependen de él).
- La conversión es **opt-in** por petición, para no cambiar lo que reciben otros clientes ni la app ya publicada.
- Si la conversión de una fórmula falla, se deja el LaTeX original en el HTML (la app tiene plan B con KaTeX mientras dure la transición).

Fuera de alcance: tocar la web, convertir imágenes `data:` base64 a archivos (mejora aparte, ver §9).

## 2. Qué hay hoy en la API (verificado en el código)

- Todos los serializadores pasan el HTML por `absolutizeHtml` (`src/libs/urls.js`), que es **síncrono**: `question.serializer.js`, `exam.serializer.js`, `simulacrum.service.js` (dos bloques: ~líneas 380–388 y 717–729), `practice.service.js` (resolución en la corrección), `store.service.js` (descripción de producto; no necesita math). En total **~20 llamadas en 5 archivos**.
- `serializeQuestion` se usa como `items.map(serializeQuestion)` en 5 sitios (`question.service`, `practice.service` ×2, `list.service`); hacerla `async` obligaría a `Promise.all` y a no pasar el índice como segundo argumento.
- No existe la carpeta `scripts/` en este repo: `scripts/migrate_base64_images.js` solo se menciona en comentarios de `question_media.js`. Los scripts de §6 son nuevos.
- `app.js` aplica `helmet()` global (incluye `Cross-Origin-Resource-Policy: same-origin` por defecto).
- Ya existe un patrón de almacenamiento servido: `src/libs/avatar_storage.js` (guarda en `settings.storageDir`, valida el nombre con regex) + `src/modules/media/media.routes.js` (`/media/avatars/:file`, `Cache-Control: public, max-age=31536000, immutable`).
- `libs/kv.js` es el almacén clave-valor efímero (Redis con prefijo `api:` y respaldo en memoria).
- No hay MathJax ni KaTeX en `package.json`. Node `>=20`, ESM, pruebas con `node --test`.

## 3. Diseño

```
pregunta (HTML con LaTeX)
   └─ renderMath(html)  ── por cada fórmula ──► hash = sha1(tex + modo + MATH_VERSION)
                                                  │ ¿existe storage/math/<hash>.svg?
                                                  ├─ sí  → usarlo
                                                  └─ no  → MathJax (Node) → guardar → usarlo
   └─ HTML con <img class="math" src=".../media/math/<hash>.svg" data-…>
```

### 3.1 Módulo `src/libs/math_svg.js`

Responsabilidades:
1. **Extraer fórmulas** del HTML: delimitadores `\[…\]` y `$$…$$` (bloque), `\(…\)` (línea). Ignorar lo que esté dentro de `<script>`/`<style>`. Decodificar entidades HTML dentro del TeX (`&lt;`, `&amp;`, `&nbsp;`), porque el banco guarda HTML, no TeX puro. **Quitar también las etiquetas** que caigan dentro de los delimitadores (`\[ a<br>b \]`, `<span>…</span>`), convirtiendo `<br>` en espacio.
2. **Decidir bloque o línea** con la misma regla que ya usa la app (`HtmlBlocks.inlineMixedDisplayMath`): una fórmula `\[ \]` que comparte línea con texto o `<img>` se renderiza **en línea con `\displaystyle`**; si está sola en su párrafo (o tras un `<br>`), en bloque. Moverla a la API evita duplicar la regla en cada cliente.
3. **Generar el SVG** con MathJax en Node (`tex` → `svg`), paquetes `base`, `ams`, `mhchem` y `cancel` (los mismos que carga la web; **sin** `noundefined`, ver §4.1). Salida `SVG({ fontCache: 'none' })` → cada archivo es autocontenido. Es obligatorio un post-proceso (§4.1): atributos inline en `rect[data-frame]`/`line[data-line]`, tildes normalizadas antes de convertir, unidades `ex` a px. Datos de medida: `width`, `height` y `vertical-align` (en `ex`) del `<svg>` resultante.
4. **Cachear** en `STORAGE_DIR/math/<hash>.svg` + `<hash>.json` con las medidas, y un **LRU en memoria** `hash → {w,h,valign}` (p. ej. 20 000 entradas, unos KB cada una). Cada `<img>` necesita esas medidas en cada petición; sin el LRU habría una lectura de disco por fórmula por petición. Al arrancar el LRU está vacío y se llena de forma perezosa leyendo el `.json`.
   **Escritura atómica:** escribir a `<hash>.svg.<rand>.tmp` y `rename`, para que dos peticiones simultáneas nunca sirvan un archivo a medias.
5. **Sustituir** cada fórmula por:
   ```html
   <img class="math" src="{base}/api/v1/media/math/<hash>.svg"
        alt="<tex>" data-tex="<tex escapado>" data-display="true|false"
        data-w="5.12ex" data-h="2.01ex" data-valign="-0.57ex">
   ```
   `alt`/`data-tex` conservan el LaTeX (accesibilidad y plan B).

Detalles de implementación:
- **La conversión de MathJax es CPU síncrona** (con los paquetes cargados de antemano no hay trabajo asíncrono real). Por eso un `Promise.race` con timeout no interrumpe un TeX patológico y una "cola de concurrencia" en el hilo principal no paraleliza nada. Decisión: **ejecutar MathJax en un `worker_threads`** (un worker, ampliable a 2), con un documento MathJax por worker (inicialización cara, ~cientos de ms). El hilo principal solo manda `{tex, display}` y recibe `{svg, w, h, valign}`.
- **Timeout por fórmula** (p. ej. 2 s) aplicado desde el hilo principal: si vence, `worker.terminate()` y se crea otro worker; esa fórmula queda como fallo. `formatError` lanza excepción → se deja el LaTeX original y se registra en el log con el id de la pregunta.
- **Límite de tamaño** del TeX (p. ej. 4 KB) para no procesar contenido malicioso o roto.
- **Sanitizar el SVG** antes de guardarlo: MathJax no genera `<script>`, pero se rechaza cualquier SVG que contenga `<script`, `on*=` o `href` externos. Servir con `Content-Type: image/svg+xml` y `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`.
- **Colores:** guardar con `currentColor` (no negro fijo) para que el cliente lo tiña según el tema. Verificado en el spike: MathJax ya emite `currentColor` por defecto, no hace falta post-proceso de color.

### 3.2 Hash y versionado

`hash = sha1(JSON.stringify({ tex, display, v: MATH_VERSION })).hex` (primeros 32 caracteres bastan).
- `MATH_VERSION` = versión de `@mathjax/src` + una constante propia que se sube si cambia la plantilla de post-proceso.
- Cambiar la versión invalida todo solo (los hashes cambian); los archivos viejos quedan huérfanos → script de limpieza (§6).
- El mismo TeX en mil preguntas = un solo archivo.

### 3.3 Ruta de media

`GET /api/v1/media/math/:file` en `media.routes.js`, mismo patrón que avatares:
- Validar `:file` con `/^[a-f0-9]{32}\.svg$/` (evita path traversal).
- `Cache-Control: public, max-age=31536000, immutable`, `Content-Type: image/svg+xml`, ETag.
- Pública (las fórmulas no son datos de usuario).
- Si el archivo no existe: `404` (la app cae al plan B). No se regenera al vuelo desde esta ruta, porque no tiene el TeX.

### 3.4 Opt-in y punto de integración

Parámetro `?math=svg` (ver D1). Sin él, el comportamiento actual no cambia.

Punto de integración: **una sola capa de respuesta**, sin tocar los serializadores (que siguen síncronos). Un middleware `mathResponse` (`src/middlewares/math_response.js`), montado solo en las rutas de preguntas, prácticas, exámenes, simulacros y listas:
1. Si `req.query.math !== 'svg'`, no hace nada (contrato intacto, sin coste).
2. Si es `svg`, envuelve `res.json`: antes de enviar, recorre el payload y aplica `renderMath` (asíncrono, vía worker) **solo a una lista blanca de claves HTML**: `question`, `options[].text`, `context.text`, `explanation`, `text` de lecturas de examen/simulacro. Cualquier otra clave no se toca.
3. Los fallos de una fórmula se loguean con el id de la pregunta más cercano en el payload; nunca hacen fallar la respuesta.

Ventajas frente a convertir ~20 llamadas a `async`: un solo archivo nuevo, ninguna firma cambia, el flag vive en `req` y no hay que pasarlo por controlador → servicio → serializador. Costes: la lista blanca de claves debe mantenerse al día cuando se añadan campos HTML (cubierto por una prueba que recorre los payloads reales de cada endpoint y falla si queda LaTeX sin convertir en un campo no listado), y los payloads grandes se recorren una vez más (trivial frente a la generación).

Descartada: hacer `serializeQuestion` y compañía `async` (toca 5 archivos y 5 `.map(serializeQuestion)`, y no aporta nada si la conversión va a un worker de todos modos).

Campos a cubrir: `question`, `options[].text`, `context.text` (lectura), `explanation`/`resolution` en la corrección de prácticas, y los equivalentes de exámenes y simulacros. Fuera: `store.service` (descripción de producto).

## 4. Orden de implementación (commits pequeños)

0. **Spike (antes de construir nada).** Script desechable que convierta con MathJax en Node las ~10 fórmulas más complejas de la muestra (`\ce`, `array`+`\hline`, `\underbrace`, `\cancel`, fracciones anidadas) y comprobar que **Coil + `SvgDecoder` (AndroidSVG)** las pinta bien: unidades `ex`, `<use>` de `fontCache: 'local'`, `currentColor`. Si falla, probar `fontCache: 'none'` y convertir `ex` a px/em al generar. Además, cerrar **D3 y D4** (§8). Resultado: ajustar §3.1 antes de seguir. **Ejecutado el 2026-10-02 en Node 24 (mitad Node, sin Android); ver §4.1.** Queda pendiente solo la comprobación en dispositivo con Coil.
1. **Dependencias y módulo puro** `libs/math_svg.js` con pruebas (extracción, bloque/línea, entidades, etiquetas dentro del TeX). Sin red ni disco. **Hecho (2026-10-02):** `src/libs/math_svg.js` + `test/math_svg.test.js` (23 pruebas), `mathjax-full@3.2.1` añadido a `package.json`. El módulo también ignora `<code>` y `<pre>` (además de `<script>`/`<style>`) y normaliza tildes dentro de `\text{}`. Pendiente de fases 2–3: generación con MathJax, medidas y post-proceso del SVG.
2. **Generación en worker + caché** (`storage/math`, LRU de medidas, escritura atómica), con prueba de ida y vuelta (mismo TeX → mismo archivo; versión distinta → archivo distinto; timeout → fallo controlado y worker recreado). **Hecho (2026-10-02):** `src/libs/math_render.js` (MathJax + post-proceso y validación del SVG), `src/libs/math_worker.js`, `src/libs/math_store.js` (renderizador con worker y timeout, `createMathStore`, LRU, escritura atómica, `mathFilePath` para la ruta del paso 3) y `test/math_store.test.js` (29 pruebas). Detalles: el JSON de medidas se escribe después del SVG y marca "completo"; un fallo no se cachea; los SVG con `<text>` se rechazan (p. ej. `¿` dentro de `\text{}`); `MATH_VERSION` = `mj<versión MathJax>-t<plantilla>`.
3. **Ruta `/media/math/:file`** + pruebas (validación del nombre, cabeceras, 404). **Hecho (2026-10-02):** ruta en `media.routes.js` y `test/math_media.test.js` (6 pruebas). Las cabeceras viajan en la opción `headers` de `sendFile`, así que un 404 (JSON) no sale etiquetado como SVG. La ruta queda **exenta del rate limit global** (`src/modules/index.js`): una pantalla con muchas preguntas pediría decenas de SVG y agotaría los 120/min de la IP (o de toda una red NAT); el resto de rutas sigue limitado. Añade `Cross-Origin-Resource-Policy: cross-origin` y `sandbox` en la CSP.
4. **Middleware `mathResponse`** con lista blanca de claves, apagado salvo `?math=svg`. Primero en preguntas y prácticas. **Hecho (2026-10-02):** `src/middlewares/math_response.js` montado en `/preguntas`, `/practicas-area` y `/practicas` (`src/modules/index.js`); `test/math_response.test.js` (17 pruebas). Detalles: (a) los esquemas de query son estrictos (`additionalProperties: false`), por eso el middleware va **antes** de las validaciones, lee `math` y lo quita de `req.query`; `?math=` con otro valor da 422; (b) lista blanca = `question`, `text`, `explanation` (cubre pregunta, opciones, lectura y explicaciones de responder/finalizar); (c) no muta el payload original; (d) las respuestas de error (≥400) no se transforman; (e) presupuesto de 5 s por respuesta: lo que no alcance a convertirse queda en LaTeX y se completa en las siguientes peticiones; (f) si el almacén falla, la respuesta sale igual con el LaTeX y se registra con el id de la pregunta.
5. **Extender** a exámenes, simulacros y listas, con la prueba que detecta LaTeX en claves no listadas. **Hecho (2026-10-02):** `mathResponse` montado también en `/examenes`, `/simulacros` y `/mis-listas`; `test/math_coverage.test.js` (8 pruebas) siembra LaTeX en todos los campos HTML de la fuente (pregunta, opciones, resolución, lectura) y recorre las respuestas de preguntas (detalle, listado, responder), prácticas (por área, detalle y finalizar), exámenes (vista de docente), simulacros (iniciar y solucionario) y listas: falla si queda `\(`, `\[` o `$$` en cualquier texto. `/mis-listas/:id/pdf` no devuelve JSON y no se ve afectado. **Bug encontrado y corregido por esa prueba:** el timeout de 2 s por fórmula incluía el arranque del worker (carga de MathJax ~1 s, más con la máquina cargada), así que la primera petición tras arrancar podía fallar. Ahora el worker avisa `{ ready: true }` tras calentar MathJax y el plazo cuenta solo desde que recibe la fórmula; hay un plazo de arranque aparte (20 s).
6. **Scripts de precalentamiento y limpieza** (§6; crear la carpeta `scripts/`) y documentación en el spec (`api-eduteka-standalone.md`, notas de la fase de preguntas). **Hecho (2026-10-02):** `scripts/warm_math_cache.js` (`npm run math:warm`) y `scripts/prune_math_cache.js` (`npm run math:prune`), con `src/libs/math_catalog.js` (recorre preguntas practicables, bloques, exámenes verificados y simulacros publicados) y `src/libs/math_cache_admin.js` (tamaño y poda); `test/math_warm.test.js` (10 pruebas, incluidos los scripts contra una Mongo en memoria). El warm acepta `--source`, `--limit`, `--dry-run`, `--failures=csv` y `--strict`; el prune informa por defecto y solo borra con `--apply`, no toca archivos de menos de 60 min ni ajenos a la cache, y aborta si el banco no devuelve fórmulas (conexión equivocada). Ambos rechazan opciones desconocidas. Documentado en `api-eduteka-standalone.md` §6.2. **Pendiente de ejecutar contra la base real:** medir tiempo, peso en disco, fórmulas fallidas y comparar con la muestra de 1.988 preguntas (18 % con LaTeX).

### 4.1 Resultados del spike (paso 0)

Probado con `mathjax-full@3.2.1` y `@mathjax/src@4.1.3`, 17 fórmulas (las del §5 + 2 inválidas) y render con `@resvg/resvg-js` como sustituto estricto de AndroidSVG. **No** se probó Coil en un dispositivo.

**Funciona**
- Las 15 fórmulas válidas convierten sin error, incluidas `\ce{SO4^2- + Ba^2+ -> BaSO4 v}`, `array` con `\hline`, `\underbrace`, `\cancel`/`\bcancel`, fracciones anidadas y `\widehat`. `\frac{` lanza excepción con `formatError` (fallo detectable).
- La salida usa `fill/stroke="currentColor"`: no hace falta sustituir negros (no aparece ningún `black` ni `#000`). Sin `<script>`, `on*=` ni `href` externos.
- Rendimiento: inicialización ~15 ms (no cientos), 1–30 ms por fórmula, 1–10 KB por SVG.
- `fontCache: 'none'` deja los SVG sin `<use>` de glifos (más autocontenidos para AndroidSVG) y pesa parecido a `'local'`: **usar `'none'`**.

**Problemas encontrados (y su arreglo, ya validado con resvg)**
1. **Tablas (`array`, `\hline`, `|c|c|`) salen como cuadrado negro.** MathJax pone el trazo de marcos y líneas (`rect[data-frame]`, `line[data-line]`) en una hoja CSS que no viaja dentro del SVG. Post-proceso obligatorio: añadir `fill="none" stroke-width="70"` a esos elementos. Con eso la tabla renderiza bien. Añadir también `stroke-dasharray` para las clases `mjx-dashed`/`mjx-dotted` si aparecen en el banco.
2. **Letras con tilde y `ñ` salen como `<text font-family="serif">`**, no como trazados: dependen de la fuente del dispositivo y el ancho no coincide con el calculado (en resvg se vio "té rminos" con hueco). Es el caso habitual en español. Arreglo: antes de convertir, normalizar `á é í ó ú ñ ü` dentro de `\text{}` a `\'a`, `\'e`, `\~n`… (probado: `\text{t\'erminos}` da 0 `<text>` y 10 trazados). Alternativa: rechazar el SVG si contiene `<text>` y dejar el LaTeX.
3. **`noundefined` oculta los errores:** `\foo{x}` no lanza, se dibuja en rojo (`fill="red"`). Con ese paquete el "fallo controlado" del §5 no se dispara. Decisión: **no cargar `noundefined` en el servidor** (se espera que `formatError` lance; confirmar con una prueba) o, si se mantiene, rechazar el SVG que contenga `fill="red"`.
4. **Unidades `ex`:** `width`, `height` y `vertical-align` salen en `ex`. Convertirlas al generar (1 ex = 8 px con `em: 16, ex: 8`, o dejarlas en `ex` solo en `data-*`) y quitar el `style="vertical-align:…"` del `<svg>`, que AndroidSVG ignora.

**Límites reales de coste** (todo en el hilo principal, sin infinitos):
| TeX | tiempo | SVG |
|---|---|---|
| 4 KB, `\frac` anidado 400 niveles | 105 ms | 184 KB |
| `array` 20×20 | 137 ms | 541 KB |
| 3,8 KB `a+a+…+b` | **585 ms** | **1,7 MB** |
| `\def\a{\a\a}\a` | 7 ms (corta por `maxMacros`) | — |
| torre de superíndices (300) | falla con `Maximum call stack` (capturable) | — |
Conclusiones: ningún TeX cuelga el proceso, pero sí hay entradas de ~0,6 s y SVG de MB. Añadir **tope de tamaño del SVG de salida (p. ej. 300 KB → fallo)** además del tope de 4 KB de TeX, y configurar `maxMacros: 1000` y `maxBuffer: 5 KB`. El worker se mantiene (las entradas de ~0,6 s bloquearían el event loop), pero ya no hay riesgo de bucle infinito que obligue a `terminate()` agresivo.

**D4 (resuelta provisionalmente): usar `mathjax-full@3`.**
- v3 convierte de forma 100 % síncrona; v4 (`@mathjax/src`) exige `convertPromise` en cuanto aparece un carácter fuera de los rangos de fuente precargados (`\text{términos}` → "an asynchronous action is required") y mostró "Invalid variant: -mhchem".
- Lo que **no** se pudo verificar: qué versión carga la web (no está en este repo; `list_pdf.js` solo menciona MathJax en un comentario). Si la web usa v4, comparar visualmente unas pocas fórmulas antes de cerrar.

**Pendiente del spike**
- Render real en Android con Coil + `SvgDecoder` de las SVG post-procesadas (`array`, `\ce`, `\underbrace`, con tilde). El spike deja los archivos en el directorio temporal de la sesión; hay que copiarlos a la app para probarlos.
- Confirmar que sin `noundefined` un comando desconocido lanza excepción.

## 5. Pruebas (`node --test`)

- **Extracción:** `\[…\]`, `\(…\)`, `$$…$$`; fórmula con `<` y `&` escapados; varias por párrafo; dentro de `<ul><li>`; sin fórmulas (HTML intacto, mismo objeto de salida).
- **Bloque vs línea:** los tres casos reales del banco — `Si: <img> \[=4x-1\] y …` (línea), `20 \[\Omega\] cada una` (línea), párrafo con solo `\[…\]` (bloque).
- **Comandos reales** de la muestra (frecuencia en el banco): `\frac`, `\sqrt`, `\overline`, `\text`, `\ce{2H2 + O2 -> 2H2O}`, `\begin{array}…\hline`, `\mathbb`, `\widehat`, `\vec`, `\underbrace`, `\cancel`. Todos deben producir SVG sin error.
- **Fallo controlado:** TeX inválido (`\frac{`) y comando desconocido (`\foo{x}`) → el HTML conserva el LaTeX original; no lanza.
- **Post-proceso del SVG (§4.1):** `array` con `\hline` produce `rect/line` con `fill="none"`; `\text{términos}` no deja ningún `<text>`; la salida no tiene `ex` ni `vertical-align`; SVG de salida > 300 KB → fallo.
- **Worker:** TeX que cuelga el render → vence el timeout, se descarta el worker, la siguiente fórmula se convierte con uno nuevo.
- **Concurrencia de escritura:** dos conversiones simultáneas del mismo TeX dejan un único archivo íntegro.
- **TeX con HTML:** `\[ a<br>b \]` y `<span>` dentro de los delimitadores se convierten sin error.
- **Lista blanca:** recorrer los payloads de cada endpoint con `?math=svg` y verificar que no queda `\[`, `\(` ni `$$` en ninguna clave de texto.
- **Seguridad:** nombre de archivo con `../`, SVG con `<script>`, TeX gigante.
- **Idempotencia:** convertir dos veces el mismo HTML da el mismo resultado y no reescribe archivos.
- **Contrato:** con `math` apagado, la respuesta es byte a byte la actual (las pruebas existentes de `questions`, `practices`, `exams`, `simulacra` siguen pasando sin cambios).

## 6. Operación

- **Precalentamiento** (la carpeta `scripts/` hay que crearla; hoy no existe): `scripts/warm_math_cache.js` recorre las preguntas verificadas y practicables que contengan LaTeX (en una muestra de 1.988 preguntas, 363 lo traían, ~18 %), genera sus SVG y reporta fórmulas fallidas. Es idempotente y se puede relanzar. Hay que medir el tiempo y el peso total al ejecutarlo la primera vez; no los doy por conocidos.
- **Revisión de fallos:** el script debe listar las preguntas cuyo TeX no se pudo convertir; son candidatas a corregirse en el banco (también se verían mal en la web).
- **Limpieza:** `scripts/prune_math_cache.js` borra archivos cuyo hash ya no aparece con la `MATH_VERSION` actual.
- **Almacenamiento:** `STORAGE_DIR/math` debe estar en un volumen persistente (hoy `STORAGE_DIR` ya aloja avatares). **Con varias instancias o disco efímero la ruta devolvería 404 aleatorios** (la instancia A genera, la B sirve): por eso D3 se resuelve antes del paso 3, con volumen compartido o almacenamiento externo.
- **Ráfaga de peticiones:** una pantalla de 20–50 preguntas con fórmulas implica decenas de GET a SVG en la primera carga. Medirlo en el precalentamiento y confirmar que `immutable` + caché de Coil lo absorben.
- **Métricas/log:** conteo de aciertos/fallos de caché y tiempo de generación (`logger`), para decidir si hace falta precalentar más.

## 7. Cambios en la app (después de la API)

1. Añadir `coil-svg` y registrar `SvgDecoder`; eliminar `assets/katex`, `MathHtml.kt` y la rama de WebView de `RichHtml`.
2. Pedir `?math=svg` en los endpoints de preguntas/prácticas.
3. En `RichHtml`, tratar `<img class="math">` como contenido en línea con `InlineTextContent`: ancho/alto desde `data-w`/`data-h` (1 ex ≈ 0,5 em), desplazamiento vertical desde `data-valign`, `ColorFilter.tint` con el color del texto (modo oscuro gratis). Las de `data-display="true"` van centradas en su propia línea, reducidas si exceden el ancho.
4. Mantener KaTeX como respaldo hasta que la API esté estable (si `data-tex` viene sin SVG o la imagen falla, se muestra el LaTeX en WebView); retirarlo después.
5. `contentDescription` desde `data-tex`/`alt` para TalkBack (hoy las fórmulas del WebView no son accesibles con el mismo detalle).

## 8. Decisiones abiertas

- **D1:** parámetro `?math=svg` o cabecera `X-Math-Format`. Recomendado: parámetro de consulta (más fácil de probar y de depurar en logs).
- **D2 (resuelta):** medidas en `<hash>.json` junto al SVG, más un LRU en memoria. Leerlas del SVG en cada petición implicaría un `readFile` por fórmula por petición.
- **D3 (resuelta 2026-10-02):** el despliegue real tiene **una sola instancia con disco SSD**, así que `STORAGE_DIR/math` local basta y la ruta no devuelve 404 aleatorios. Si algún día se escala a varias instancias, habrá que pasar a disco compartido, S3/Cloudinary (`libs/cloudinary.js`) o CDN; el hash por contenido facilita esa migración. Comprobar que `STORAGE_DIR` esté en un volumen persistente (no se pierde al redesplegar).
- **D4 (provisional: MathJax 3, `mathjax-full`):** v3 es síncrono; v4 exige async y mostró avisos con `mhchem` (§4.1). Falta confirmar qué versión carga la web (no está en este repo) para igualar el render.
- **D5:** qué hacer con las imágenes `data:` base64 (~20 % de las imágenes, hasta ~400 KB cada una): migrarlas a archivos con el mismo mecanismo (`scripts/migrate_base64_images.js` ya existe según `question_media.js`). Mejora independiente, pero relacionada porque también reduce el tamaño del JSON.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Integrar en ~20 llamadas de 5 archivos | Una sola capa (`mathResponse`) con lista blanca de claves; serializadores intactos |
| MathJax es CPU síncrona: un TeX patológico bloquea el event loop | Worker thread con timeout y `terminate()`; límite de 4 KB de TeX |
| MathJax lento en la primera petición de una pregunta no precalentada | Precalentamiento + caché en disco y en memoria (LRU de medidas) |
| Lectura de disco por fórmula en cada petición | LRU en memoria de medidas; `.json` solo como respaldo |
| Archivo a medias por escrituras concurrentes | Escritura a temporal + `rename` |
| Varias instancias: SVG generado en una y pedido a otra → 404 | D3 resuelta antes de publicar la ruta |
| Coil/AndroidSVG no soporta algo del SVG de MathJax (`ex`, `<use>`, `array`) | Spike del paso 0; `fontCache: 'none'` y conversión de unidades si hace falta |
| `helmet` impide cargar las imágenes desde otro origen web | Irrelevante para la app nativa; si la web las usara, ajustar `Cross-Origin-Resource-Policy` en esa ruta |
| Diferencias de render entre MathJax (servidor) y la web | Misma versión mayor (D4); comparar visualmente una muestra de las fórmulas más complejas (`array`, `\ce`, `\underbrace`) |
| El TeX del banco trae HTML/entidades | Decodificar entidades antes de convertir; pruebas con casos reales |
| Almacenamiento crece sin control | Deduplicación por hash + script de limpieza por versión |
| SVG como vector de ataque | Generado solo por MathJax, validado al guardar, servido con CSP restrictiva y nombre validado |

## 10. Criterio de terminado

- Con `?math=svg`, el 100 % de las fórmulas de la muestra de 1.988 preguntas se convierte (o queda registrada como fallo con el id de su pregunta) y la respuesta no contiene `\[`, `\(` ni `$$` fuera de los casos fallidos y de una lista explícita de excepciones (delimitadores que aparezcan como texto literal, p. ej. explicando sintaxis o en `<code>`), que se documenta al ejecutar el precalentamiento por primera vez.
- Las pruebas existentes pasan sin modificarlas; las nuevas cubren §5.
- La app, con la rama nativa, muestra las mismas preguntas que hoy se ven con KaTeX (revisión visual de las que usan `\ce`, `array`, fracciones anidadas y fórmulas junto a imágenes).
