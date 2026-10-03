import mongoose from 'mongoose';
import crypto from 'crypto';
import { resolveAreaId } from '#Libs/area_link.js';
import simulacrumReferenceSchema from '#Schemas/simulacrum_reference_schema.js';

const { Schema } = mongoose;

const ExamReferenceSchema = new Schema({
    id_exam: String,
    exam_slug: String,
    exam_institution_id: String,
    exam_title: String,
    exam_areas: [String], // Vacio significa area unica
    // La pregunta se cargo para este examen pero un editor la deselecciono, asi
    // que NO forma parte de el. `removeQuestionFromExam` (exam-area.service.js)
    // no limpiaba la referencia y no habia manera de distinguir este caso de una
    // pertenencia real. Se marca en lugar de borrar la entrada para conservar la
    // procedencia y el vinculo con la institucion, del que dependen el
    // auto-ensamblado de simulacros, la busqueda de candidatos y los filtros de
    // practicas (todos consultan `iexam.exam_institution_id`).
    deselected: { type: Boolean, default: false }
}, { _id: false });

// Espejo de ExamReferenceSchema para simulacros. Es un array porque una misma
// pregunta puede reutilizarse en varios simulacros (hoy hay 53 asi), algo que el
// campo `simulacrum` singular de mas abajo no puede representar.
//
// Vive en su propio fichero porque `blocks` lleva exactamente el mismo array:
// las lecturas tambien se reutilizan entre simulacros.
const SimulacrumReferenceSchema = simulacrumReferenceSchema;

const QuestionImageSchema = new Schema({
    url: { type: String, required: true },
    type: { type: String, enum: ['question', 'option', 'resolution'], required: true }
}, { _id: false });

// De donde sale la figura de una pregunta importada desde PDF.
//
// El enunciado solo conserva el marcador pelado `[IMAGEN]`, porque el texto del
// marcador entra en `question_raw` y en el `hash` que detecta duplicados (ver
// extractFigureMarkers en #Libs/read_text_questions.js). La pagina y la
// descripcion que dio el modelo al extraer viven aqui, que es lo que permite
// despues volver al PDF, recortar la figura y generarla.
const FigureMarkerSchema = new Schema({
    page: { type: Number, default: null },
    description: { type: String, default: null },
    target: { type: String, enum: ['question', 'resolution'] }
}, { _id: false });

const FigureSourceSchema = new Schema({
    extraction_id: { type: String, default: null },
    figures: [FigureMarkerSchema]
}, { _id: false });

// Figura propuesta por la IA para una pregunta con [IMAGEN]. Como `ai_suggestion`,
// NO se aplica sola: una persona compara el recorte del PDF con lo generado y
// decide. Ver #Services/figure_queue.service.js
const FigureSuggestionSchema = new Schema({
    figure_id: String,
    description: String,
    tags: [String],
    page: Number,
    // Caja que devolvio el modelo (escala 0-1000) y recorte del original que
    // salio de ella: es lo que se le ensena al revisor al lado de la figura.
    box: [Number],
    crop_file: String,
    model: String,
    at: Date,
    // La propuesta NO se borra al aplicarla: queda como trazabilidad de que
    // propuso el modelo frente a lo que se publico.
    applied: { type: Boolean, default: false },
    applied_at: Date
}, { _id: false });

// Propuesta de la revision con IA. No se aplica sola: un humano la revisa y
// decide. Ver #Services/ai-batch-processor.service.js
const AiSuggestionSchema = new Schema({
    question: String,
    rpta: String,
    resolution: String,
    needs_manual_review: Boolean,
    model: String,
    at: Date,
    // La sugerencia NO se borra al aceptarla: queda como trazabilidad de que
    // dijo el modelo frente a lo que finalmente se guardo. `applied` es lo que
    // distingue "pendiente de validar" de "ya revisada por una persona", y es
    // lo que la tarjeta de verificacion usa para pintar el badge.
    applied: { type: Boolean, default: false },
    applied_at: Date,
    // Que campos acepto el revisor de los tres que propone la IA
    // (question / rpta / resolution). Sirve para auditar cuando la IA acerto
    // solo a medias.
    applied_fields: [String]
}, { _id: false });

// Propuesta de TEMA de la revision con IA. Va aparte de `ai_suggestion` a
// proposito: son dos tareas distintas sobre poblaciones casi disjuntas.
// `ai_suggestion` resuelve preguntas SIN `rpta`; esto clasifica preguntas que
// ya son practicables (con `rpta` y verificadas) pero no tienen tema. Meterlas
// en el mismo campo obligaria a que `ai_status` significase dos cosas a la vez.
//
// Tampoco se aplica sola: un humano la revisa, igual que la sugerencia de rpta.
const AiTopicSchema = new Schema({
    topic: String,
    // true  = el modelo eligio un tema del vocabulario que ya existia en el area.
    // false = ninguno encajaba y propuso uno nuevo. Los nuevos son los que hay
    //         que mirar con lupa: son la via por la que se cuelan los sinonimos
    //         ("Ecuaciones cuadraticas" / "Ecuacion de segundo grado") que
    //         convirtieron `area` en 90 variantes para 84 areas reales.
    matched: Boolean,
    confidence: Number,
    model: String,
    at: Date,
    applied: { type: Boolean, default: false },
    applied_at: Date
}, { _id: false });

const questionsSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    topic: String,
    // Area en texto libre, tal como se cargo el examen ("QUÍMICA", "Química",
    // "QUIMICA"). Se conserva porque de ella se deriva el `slug` de la pregunta
    // y porque medio sistema todavia filtra por ella.
    area: String,
    // Relacion con el catalogo de areas. Es la referencia buena: `area` es texto
    // libre con 90 variantes para 84 areas reales, `area_id` apunta a un unico
    // documento de `areas`. Se resuelve por el slug del area.
    area_id: { type: String, ref: 'Area' },
    slug: { type: String }, // unicidad declarada abajo como indice parcial
    competition: String,
    difficulty: String,
    type: String,
    image: String,
    images: [QuestionImageSchema],
    question: { type: String },
    question_raw: String,
    source: String,
    options: Object,
    options_answers: Object,
    dependence: { type: Object, ref: 'Block' },
    total_answers: Number,
    state: { type: Boolean, default: false },
    resolution: String,
    verified: { type: Boolean, default: false },
    rpta: String,
    rpta_text: String,
    created_by: String,
    verified_by: String,
    // Discriminante entre el banco oficial y el banco privado de un docente.
    // "Docente" es el unico valor que significa algo: TODO lo demas, incluidos
    // los documentos anteriores a este campo (que no lo tienen), es oficial. Por
    // eso las lecturas del banco oficial filtran por `{ $ne: 'Docente' }` y no
    // por `{ origin: 'Oficial' }`, y por eso no hizo falta backfill.
    // Ver OFFICIAL_BANK_FILTER en #Services/teacher_question.service.js
    origin: { type: String, enum: ['Oficial', 'Docente'], default: 'Oficial' },
    // Alcance de una pregunta de docente. Hoy solo se escribe 'private'; 'clase'
    // esta declarado para la fase siguiente y ninguna ruta lo escribe todavia.
    // Sin default a proposito: un default lo estamparia tambien en las preguntas
    // que crean la ingesta de examenes y el panel de administracion, donde el
    // campo no significa nada.
    visibility: { type: String, enum: ['private', 'clase'] },
    exam: String,
    exam_area: String,
    iexam: [ExamReferenceSchema], // Changed to Array
    simulacrums: [SimulacrumReferenceSchema],
    simulacrum: Object,
    hash: { type: String } ,
    uid: { type: String, unique: true, index: true },
    revision: String,
    n: Number,
    type_correction: String,
    figure_source: FigureSourceSchema,
    figure_suggestion: FigureSuggestionSchema,
    // Mismo criterio que `ai_status`: 'rejected' es "una persona la descarto" y
    // no se vuelve a encolar; 'failed' es un fallo tecnico y si se reintenta.
    figure_status: { type: String, enum: ['ok', 'failed', 'pending', 'rejected', null], default: null },
    figure_error: String,
    is_ai_solved: { type: Boolean, default: false },
    needs_manual_review: { type: Boolean, default: false },
    ai_suggestion: AiSuggestionSchema,
    // 'rejected' = una persona miro la propuesta de `ai_suggestion` y la descarto.
    // Se distingue de 'failed' (fallo tecnico) para que scripts/enqueue_ai_review.js
    // no la vuelva a mandar al modelo ni con --retry-failed, y para poder medir
    // cuanto se equivoca el modelo. Mismo criterio que `ai_topic_status`.
    ai_status: { type: String, enum: ['ok', 'failed', 'pending', 'rejected', null], default: null },
    ai_error: String,
    ai_topic: AiTopicSchema,
    // 'rejected' = una persona miro la propuesta y la descarto. Se distingue de
    // 'failed' (fallo tecnico) para que el encolado no la reintente y para poder
    // medir cuanto se equivoca el clasificador.
    ai_topic_status: { type: String, enum: ['ok', 'failed', 'pending', 'rejected', null], default: null },
    ai_topic_error: String,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

questionsSchema.index({ "images.url": 1 });
questionsSchema.index({ "simulacrums.id_simulacrum": 1 });

// La cola de figuras: candidatas (tipo C sin resolver) y cola de revision
// (propuestas sin aplicar). Mismo motivo que el indice de `ai_status`: sin el,
// cada pasada del proceso recorre el banco entero.
questionsSchema.index({ figure_status: 1, type_correction: 1 });
questionsSchema.index({ figure_status: 1, "figure_suggestion.applied": 1, "figure_suggestion.at": -1 });

// Listados y practicas filtran por area; `area` (texto) nunca estuvo indexado.
questionsSchema.index({ area_id: 1 });

// NO unico a proposito. `hash` es el MD5 del enunciado normalizado y existe para
// DETECTAR duplicados, no para impedirlos: validateDuplicate lo consulta y
// encamina la coincidencia al flujo de conflictos (fusionar / guardar como nueva).
// Con unique, insertMany en bulkSaveQuestions lanzaria excepcion en vez de dejar
// que la UI resuelva. El indice simple solo acelera esa busqueda.
questionsSchema.index({ hash: 1 });

// Encolado de la clasificacion por tema: selecciona las practicables sin tema y
// sin propuesta previa, agrupando por area. El vocabulario que se manda al
// modelo es POR AREA, asi que los lotes tienen que ser homogeneos y la consulta
// recorre area por area.
questionsSchema.index({ area_id: 1, ai_topic_status: 1 });

// Cola de revision humana de `ai_suggestion` (/preguntas/ia/revision). La
// pantalla siempre consulta lo mismo: propuestas con `ai_status: 'ok'` que
// todavia nadie aplico, filtradas por area y ordenadas por fecha de la
// propuesta. Sin indice era un COLLSCAN sobre todo el banco en cada pagina.
questionsSchema.index({ ai_status: 1, 'ai_suggestion.applied': 1, 'ai_suggestion.at': -1 });

// Banco propio del docente. Cubre sus dos consultas: el listado de
// /mis-preguntas y las elegibles para el generador de materiales
// (`teacherPublishedFilter`), ambas ordenadas por `created_at` descendente.
//
// PARCIAL a proposito: solo indexa las preguntas de docente, asi que no pesa
// sobre las decenas de miles del banco oficial. `origin` NO va como clave
// lider: dentro del filtro parcial es una constante y solo gastaria una clave.
// Mongo solo elige este indice si la consulta trae el `origin: 'Docente'`
// literal, cosa que garantiza `teacherBankFilter`.
questionsSchema.index(
    { created_by: 1, created_at: -1 },
    { partialFilterExpression: { origin: 'Docente' } }
);

// `slug` es unico pero OPCIONAL: se deriva de area+uid y no todas las preguntas
// lo tienen (las que no tienen `area` no pueden generarlo). Un indice unico
// simple falla al construirse en cuanto hay mas de un documento sin slug, y
// entonces Mongoose lo descarta en silencio: el `unique` no protegia nada.
// El indice parcial solo cubre los slugs que son string.
questionsSchema.index(
    { slug: 1 },
    { unique: true, partialFilterExpression: { slug: { $type: 'string' } } }
);

// `area_id` se resuelve aqui y no en cada controlador: las preguntas se crean y
// se editan desde muchos sitios (alta manual, procesamiento de examenes, carga
// masiva de simulacros) y basta olvidarlo en uno para que el catalogo y las
// preguntas vuelvan a divergir. Cubre `save()`; `insertMany` va mas abajo, que
// no dispara middleware de documento.
questionsSchema.pre('save', async function () {
    if (!this.isModified('area') && this.area_id) return;

    const areaId = await resolveAreaId(this.area);

    // Si el area cambio a una que no esta en el catalogo se limpia el vinculo:
    // dejar el anterior seria apuntar a un area que ya no es la de la pregunta.
    if (areaId || this.isModified('area')) this.area_id = areaId;
});

questionsSchema.pre('insertMany', async function (next, docs) {
    if (!Array.isArray(docs)) return next();

    for (const doc of docs) {
        if (!doc?.area || doc.area_id) continue;
        const areaId = await resolveAreaId(doc.area);
        if (areaId) doc.area_id = areaId;
    }

    next();
});

questionsSchema.pre('save', function (next) {
    const images = [];

    const extractLocalImages = (text, type) => {
        if (!text || typeof text !== 'string') return [];
        const matches = [...text.matchAll(/<img[^>]+src=["']([^"']+)["']/g)];
        return matches
            .map(match => match[1])
            .filter(src => src.includes('/images/questions/'))
            .map(url => ({ url, type }));
    };

    if (this.question) {
        images.push(...extractLocalImages(this.question, 'question'));
    }

    if (this.resolution) {
        images.push(...extractLocalImages(this.resolution, 'resolution'));
    }

    if (this.options) {
        let optionsValues = [];
        if (this.options instanceof Map) {
            optionsValues = Array.from(this.options.values());
        } else if (typeof this.options === 'object') {
            optionsValues = Object.values(this.options);
        }

        optionsValues.forEach(optionText => {
            images.push(...extractLocalImages(optionText, 'option'));
        });
    }

    this.images = images;
    next();
});

export default questionsSchema;
