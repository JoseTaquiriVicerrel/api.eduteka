import request from 'supertest';
import { lastCode } from './boot.js';

// Datos de prueba del catalogo y del banco de preguntas. Se insertan con el driver
// (sin pasar por los hooks de los schemas) para controlar exactamente cada campo,
// incluidos los datos "sucios" que hay en produccion.

const options = (extra = {}) => ({ A: 'uno', B: 'dos', C: 'tres', D: 'cuatro', E: 'cinco', ...extra });
const zeroes = () => ({ A: 0, B: 0, C: 0, D: 0, E: 0 });
const day = (n) => new Date(Date.UTC(2026, 0, n));

export async function seedCatalog(ctx) {
    const { db } = ctx.mongoose.connection;

    await db.collection('areas').insertMany([
        { _id: 'area-mat', name: 'Matemática', slug: 'matematica' },
        { _id: 'area-len', name: 'Lenguaje', slug: 'lenguaje' },
        { _id: 'area-vacia', name: 'Sin preguntas', slug: 'sin-preguntas' },
    ]);

    await db.collection('institutions').insertMany([
        { _id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM', image: '/images/inst/sm.png', state: true, exams_count: 12, departament: 'Lima' },
        { _id: 'inst-antigua', name: 'Antigua', abrev: 'AN', exams_count: 2 }, // sin campo state (dato antiguo)
        { _id: 'inst-oculta', name: 'Oculta', abrev: 'OC', state: false, exams_count: 99 },
    ]);

    await db.collection('questions').insertMany([
        {
            _id: 'q1', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', difficulty: 'Fácil', type: 'question',
            verified: true, rpta: 'B', origin: 'Oficial',
            question: '<p>Resuelve <img src="/images/questions/q1.png"></p>',
            resolution: '<p>Porque sí <img src="/images/questions/r1.png"></p>',
            options: options(), options_answers: zeroes(), total_answers: 0,
            iexam: [{ exam_institution_id: 'inst-unmsm', exam_slug: 'unmsm-2025' }], created_at: day(5),
        },
        {
            // Sin contadores de la comunidad (nunca respondida).
            _id: 'q2', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', difficulty: 'Difícil',
            verified: true, rpta: 'A', question: '<p>Segunda</p>', options: options(), created_at: day(4),
        },
        {
            // Pregunta antigua (sin `origin`) con texto de lectura compartido.
            _id: 'q3', area: 'Matemática', area_id: 'area-mat', topic: 'Geometría', difficulty: 'Fácil',
            verified: true, rpta: 'C', question: '<p>Triángulo</p>', options: options(),
            dependence: { id: 'b1', text: '<p>Lectura <img src="/images/blocks/b1.png"></p>' }, created_at: day(3),
        },
        { _id: 'q4', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', verified: false, rpta: 'A', question: '<p>Sin verificar</p>', options: options(), created_at: day(2) },
        { _id: 'q5', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', verified: true, rpta: 'A', origin: 'Docente', question: '<p>De docente</p>', options: options(), created_at: day(2) },
        { _id: 'q6', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', verified: true, question: '<p>Sin clave</p>', options: options(), created_at: day(2) },
        {
            _id: 'q7', area: 'Lenguaje', area_id: 'area-len', topic: 'Sinónimos', difficulty: 'Fácil',
            verified: true, rpta: 'D', question: '<p>Sinónimo de rápido</p>', options: options(), created_at: day(1),
        },
        {
            // Con votos previos de la comunidad.
            _id: 'q8', area: 'Matemática', area_id: 'area-mat', topic: 'Aritmética', difficulty: 'Media',
            verified: true, rpta: 'A', question: '<p>Votada</p>', options: options(),
            options_answers: { A: 2, B: 2, C: 0, D: 0, E: 0 }, total_answers: 4, created_at: day(6),
        },
    ]);

    // En produccion existe este indice (ningun schema lo declara); la busqueda lo necesita.
    await db.collection('questions').createIndex({ topic: 'text', question: 'text' }, { name: 'topic_text_question_text' });
}

let counter = 0;

/** Registra y verifica una cuenta por la API; devuelve { email, password, session }. */
export async function createUser(ctx, overrides = {}) {
    counter += 1;
    const body = {
        email: `seed${counter}-${Date.now()}@example.com`,
        password: 'Passw0rd!',
        username: 'Usuario Semilla',
        departament: 'Lima',
        account_type: 'Estudiante',
        ...overrides,
    };
    await request(ctx.app).post('/api/v1/auth/register').send(body).expect(201);
    const res = await request(ctx.app)
        .post('/api/v1/auth/verify-code')
        .send({ email: body.email, code: lastCode(ctx.outbox, body.email) })
        .expect(200);
    return { ...body, session: res.body.data };
}

export const bearer = (user) => ({ Authorization: `Bearer ${user.session.access_token}` });

/** Practicas guardadas (UserQuestionsList). `ownerId` es el dueño de la lista privada. */
export async function seedPractices(ctx, ownerId = 'dueno-1') {
    await ctx.mongoose.connection.db.collection('userquestionslists').insertMany([
        {
            _id: 'p1', name: 'Álgebra básica', slug: 'algebra-basica', description: 'Primeros pasos', public: true,
            // q4 no esta verificada y 'zzz' no existe: la practica las ignora.
            questions: ['q1', 'q2', 'q3', 'q4', 'zzz'], areas: [{ name: 'Matemática', count: 3 }], count_questions: 5, favorites: 2,
            created_at: day(10),
        },
        {
            _id: 'p2', name: 'Borrador privado', slug: 'borrador-privado', public: false, user: ownerId,
            questions: ['q1'], areas: [{ name: 'Matemática', count: 1 }], count_questions: 1, created_at: day(9),
        },
        {
            // El area de la lista usa la variante en mayusculas del texto del area.
            _id: 'p3', name: 'Lenguaje (nivel 1)', slug: 'lenguaje-1', public: true,
            questions: ['q7'], areas: [{ name: 'LENGUAJE', count: 1 }], count_questions: 1, created_at: day(8),
        },
    ]);
}

const q = (id, extra = {}) => ({
    id, itype: 'question', type: 'question', question: `<p>Pregunta ${id}</p>`, options: { A: 'a', B: 'b', C: 'c' },
    rpta: 'A', resolution: `<p>Explicación ${id}</p>`, area: 'Matemática', topic: 'Álgebra', ...extra,
});

/** Examenes resueltos (Exam): publicados, borrador, antiguo sin banco y sin contenido. */
export async function seedExams(ctx) {
    const sm = { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM', image: '/images/inst/sm.png' };

    await ctx.mongoose.connection.db.collection('exams').insertMany([
        {
            _id: 'e1', slug: 'unmsm-2025-i', title: 'Examen UNMSM 2025-I', description: 'Primera fase', verified: true,
            institution: sm, modality: 'Ordinario', date: new Date(Date.UTC(2025, 2, 10)), subjects: ['Matemática', 'Lenguaje'],
            image_post: '/images/posts/e1.png', favorites: 0, unique: false, created_at: day(3),
            files: { A: { path: '/private/e1-a.pdf', title: 'Cuadernillo A' }, B: { path: '' } },
            areas: {
                A: {
                    abrev: 'A', title: 'Área A', description: 'A: Ingenierías', solution: true, verified: true,
                    // gx es un marcador de conflicto y gmissing ya no esta en el banco: ninguno se sirve.
                    items: [{ id: 'g1' }, { id: 'gr1' }, { id: 'g2' }, { id: 'gx' }, { id: 'gmissing' }],
                },
                B: { abrev: 'B', title: 'Área B', description: 'B: Biomédicas', solution: false, verified: false, items: [{ id: 'g2' }, { id: 'g3' }] },
            },
            general_items: [
                q('g1', { question: '<p>Uno <img src="/images/questions/g1.png"></p>', rpta: 'B', options: { A: 'a', B: 'b', C: 'c' } }),
                { id: 'gr1', itype: 'reading_section', title: 'Lectura 1', text: '<p>Texto <img src="/images/blocks/r.png"></p>' },
                q('g2', { area: 'Lenguaje', topic: 'Sinónimos' }),
                q('g3'),
                { id: 'gx', itype: 'conflict' },
            ],
        },
        {
            // Examen antiguo: sin banco general_items, las preguntas viven dentro del cuadernillo.
            _id: 'e2', slug: 'unmsm-2024-ii', title: 'Examen UNMSM 2024-II', verified: true, institution: sm, modality: 'Extraordinario',
            date: new Date(Date.UTC(2024, 8, 1)), subjects: ['LENGUAJE'], favorites: 3, unique: true, created_at: day(2),
            areas: { I: { abrev: 'I', title: 'UNICO', items: [q('l1', { itype: 'question' }), q('l2')] } },
        },
        { _id: 'e3', slug: 'borrador', title: 'Examen borrador', verified: false, institution: sm, areas: { A: { items: [] } }, created_at: day(4) },
        {
            _id: 'e4', slug: 'antigua-2023', title: 'Examen Antigua 2023', verified: true,
            institution: { id: 'inst-antigua', name: 'Antigua', abrev: 'AN' }, modality: 'Ordinario',
            date: new Date(Date.UTC(2023, 0, 5)), subjects: [], areas: {}, created_at: day(1),
        },
    ]);
}

const sq = (id, area, rpta, extra = {}) => ({
    itype: 'question', id, area, rpta, question: `<p>Pregunta ${id} <img src="/images/questions/${id}.png"></p>`,
    options: { A: 'a', B: 'b', C: 'c', D: 'd' }, resolution: `<p>Explicación ${id}</p>`, topic: 'Tema', ...extra,
});

const generalItems = () => [
    { itype: 'reading_section', id: 'r1', title: 'Lectura', text: '<p>Texto <img src="/images/blocks/r1.png"></p>', area: 'Lenguaje' },
    sq('a1', 'Matemática', 'A'),
    sq('a2', 'Matemática', 'B'),
    sq('l1', 'Lenguaje', 'C'),
];

const scoring = { score_correct: 4, score_incorrect: -1, score_not_answered: 0 };
const hour = 3_600_000;

/**
 * Simulacros:
 *  - simulacro-general: bajo demanda, gratis, un area, 3 preguntas + una lectura.
 *  - simulacro-areas: por areas con carreras (A: 2 preguntas, B: 1, C: vacia).
 *  - simulacro-pago: S/ 15, con comprobante.
 *  - evento-proximo / evento-vivo / evento-cerrado: eventos con ventana global.
 *  - cerrado-admin: cerrado por el administrador.
 *  - simulacro-prospecto: puntaje de prospecto con conversion y preguntas por referencia.
 *  - oculto / borrador / sin-inscripcion: no visibles o con el registro cerrado.
 */
export async function seedSimulacra(ctx) {
    const { db } = ctx.mongoose.connection;
    const now = Date.now();
    const inst = { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM' };

    const base = (slug, extra = {}) => ({
        _id: `s-${slug}`, slug, title: `Simulacro ${slug}`, description: `Descripción ${slug}`, verified: true, state: true,
        automatic: false, finished: false, general: true, duration: 60, price: 0, for_register: true, public_results: true,
        institution: inst, ...scoring, created_at: new Date(now - extra.age * 1000 || now), ...extra,
    });
    const single = () => ({ I: { description: 'ÚNICO', careers: [], questions: generalItems().filter((item) => item.itype === 'question') } });

    await db.collection('simulacrums').insertMany([
        base('simulacro-general', { age: 1, general_items: generalItems(), areas: single(), image_post: '/images/posts/sg.png' }),
        base('simulacro-areas', {
            age: 2, general: false,
            areas: {
                A: { description: 'Ingenierías', careers: ['Sistemas', 'Civil'], questions: [sq('b1', 'Matemática', 'A'), sq('b2', 'Matemática', 'D')] },
                B: { description: 'Biomédicas', careers: ['Medicina'], questions: [sq('b3', 'Biología', 'B')] },
                C: { description: 'Sin preguntas', careers: [], questions: [] },
            },
        }),
        base('simulacro-pago', { age: 3, price: 15, duration: 30, general_items: generalItems(), areas: single() }),
        base('evento-proximo', { age: 4, automatic: true, start_date: new Date(now + hour), end_date: new Date(now + 2 * hour), general_items: generalItems(), areas: single() }),
        base('evento-vivo', { age: 5, automatic: true, start_date: new Date(now - hour), end_date: new Date(now + hour), general_items: generalItems(), areas: single() }),
        base('evento-cerrado', { age: 6, automatic: true, start_date: new Date(now - 3 * hour), end_date: new Date(now - hour), general_items: generalItems(), areas: single() }),
        base('cerrado-admin', { age: 7, finished: true, general_items: generalItems(), areas: single() }),
        base('privado', { age: 8, public_results: false, general_items: generalItems(), areas: single() }),
        base('sin-inscripcion', { age: 9, for_register: false, general_items: generalItems(), areas: single() }),
        base('oculto', { age: 10, verified: false, general_items: generalItems(), areas: single() }),
        base('borrador', { age: 11, state: false, general_items: generalItems(), areas: single() }),
        base('simulacro-prospecto', {
            age: 12, general: false, prospect: 'pr1', duration: 45,
            areas: { A: { description: 'Área A', careers: [], questions: [{ itype: 'question', id: 'pq1' }, { itype: 'question', id: 'pq2' }, { itype: 'block', id: 'pb1' }] } },
        }),
    ]);

    await db.collection('prospects').insertOne({
        _id: 'pr1', name: 'Prospecto', exam_unique: false, calification_type: 'score_question',
        calification: { score_correct: 2, score_incorrect: 0.5, score_not_answered: 0, score_conversion: true, score_formula_conversion: 'P * 2 + 10' },
    });
    await db.collection('blocks').insertOne({ _id: 'pb1', title: 'Bloque', text: '<p>Lectura del prospecto</p>', area: 'Lenguaje' });
    await db.collection('questions').insertMany([
        { _id: 'pq1', area: 'Matemática', question: '<p>PQ1</p>', options: { A: 'a', B: 'b' }, rpta: 'A', resolution: '<p>Exp pq1</p>', verified: true },
        { _id: 'pq2', area: 'Matemática', question: '<p>PQ2</p>', options: { A: 'a', B: 'b' }, rpta: 'B', resolution: '<p>Exp pq2</p>', verified: true },
    ]);
}
