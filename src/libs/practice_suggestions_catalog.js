/**
 * Catalogo de practicas sugeridas. Solo DATOS: la logica esta en
 * #Services/practice_suggestion.service.js.
 *
 * Dos vias, en este orden de prioridad (una pregunta cae en una sola practica):
 *
 *   VIA A — por TEMA. Para las areas donde `question.topic` ya esta bien
 *   poblado. `topic` casa contra el tema normalizado con `foldText`, asi que
 *   "SINÓNIMOS", "Sinónimos" y "Sinónimo" son la misma familia.
 *
 *   VIA B — por PALABRAS CLAVE del enunciado. Para las areas donde el tema
 *   casi no esta cargado. Los patrones se prueban contra el enunciado ya pasado
 *   por `foldText` (minusculas, sin tildes, sin signos), asi que se escriben sin
 *   tildes y sin `%`, `=`, `^`, etc.
 *
 * Dentro de una area las reglas se prueban EN ORDEN y la primera que casa se
 * queda con la pregunta: van primero las especificas y al final las anchas.
 *
 * `area` son slugs de `Area.slug`. Una familia puede abarcar varios porque el
 * banco tiene el mismo curso con nombres distintos segun la universidad
 * (Razonamiento Verbal / Habilidad Verbal).
 *
 * El nombre de la practica es `<name> · Práctica N` y el tope del DTO es de 50
 * caracteres: mantener los `name` por debajo de ~38.
 */

const VERBAL = ['razonamiento-verbal', 'habilidad-verbal'];
const MATEMATICO = [
    'razonamiento-matematico',
    'habilidad-logico-matematica',
    'razonamiento-logico-matematico',
];

/** Vía A. `topics`: patrones sobre el tema normalizado (un `topic` puede traer varios). */
export const TOPIC_FAMILIES = [
    { id: 'sinonimos', name: 'Sinónimos', areas: VERBAL, topics: [/^sinonim/] },
    { id: 'antonimos', name: 'Antónimos', areas: VERBAL, topics: [/^antonim/] },
    { id: 'analogias', name: 'Analogías', areas: VERBAL, topics: [/^analogia/] },
    { id: 'oraciones-incompletas', name: 'Oraciones incompletas', areas: VERBAL, topics: [/^oraciones? incompletas?/] },
    { id: 'terminos-excluidos', name: 'Términos excluidos', areas: VERBAL, topics: [/^terminos? excluidos?/] },
    {
        id: 'comprension-lectura',
        name: 'Comprensión de lectura',
        areas: VERBAL,
        topics: [/^comprension (de )?(lectura|lectora|textos?)/],
    },
    { id: 'plan-redaccion', name: 'Plan de redacción', areas: VERBAL, topics: [/^plan de redaccion/] },
    { id: 'inclusion-enunciado', name: 'Inclusión de enunciado', areas: VERBAL, topics: [/^inclusion de (un )?enunciado/] },
    { id: 'conectores-logicos', name: 'Conectores lógicos', areas: VERBAL, topics: [/^conectores? logicos?/] },
    { id: 'coherencia-cohesion', name: 'Coherencia y cohesión', areas: VERBAL, topics: [/^coherencia y cohesion/] },
    {
        id: 'informacion-eliminada',
        name: 'Información eliminada',
        areas: VERBAL,
        topics: [/^informacion eliminada/, /^oraciones? eliminadas?/],
    },
    { id: 'formacion-palabras', name: 'Formación de palabras', areas: VERBAL, topics: [/^formacion de palabras/] },
    { id: 'definiciones', name: 'Definiciones', areas: VERBAL, topics: [/^definiciones?$/] },
    { id: 'etimologia', name: 'Etimología y lexicología', areas: VERBAL, topics: [/^etimologia/, /^lexicologia/] },
    {
        id: 'semantica-lexico',
        name: 'Semántica y léxico',
        areas: VERBAL,
        topics: [/^series verbales/, /^semantica/, /^precision lexica/],
    },
    { id: 'operadores-matematicos', name: 'Operadores matemáticos', areas: MATEMATICO, topics: [/^operadores? matematicos?/] },
    { id: 'edades', name: 'Edades', areas: MATEMATICO, topics: [/^edades/] },
    { id: 'conteo-figuras', name: 'Conteo de figuras', areas: MATEMATICO, topics: [/^conteo de figuras/] },
];

/** Vía B. Cada regla: `keywords` se prueban contra el enunciado normalizado. */
export const KEYWORD_RULES = [
    // --------------------------------------------------------- aritmetica
    { area: 'aritmetica', id: 'mcd-mcm', name: 'MCD y MCM',
        keywords: [/m\.?c\.?[dm]\b/, /maximo comun divisor/, /minimo comun multiplo/] },
    { area: 'aritmetica', id: 'divisibilidad', name: 'Divisibilidad',
        keywords: [/\bdivisib/, /criterio de divisibilidad/, /\bnumeros? primos?\b/, /\bmultiplos? de\b/, /\bresiduo/] },
    { area: 'aritmetica', id: 'probabilidades', name: 'Probabilidades y combinatoria',
        keywords: [/\bprobabilidad/, /espacio muestral/, /experimento aleatorio/, /\bpermutacion/, /\bcombinacion/, /analisis combinatorio/] },
    { area: 'aritmetica', id: 'estadistica', name: 'Estadística',
        keywords: [/\bfrecuencia/, /\bhistograma/, /\bmoda\b/, /\bmediana\b/, /\bdesviacion/, /\bestadistic/] },
    { area: 'aritmetica', id: 'interes', name: 'Regla de interés',
        keywords: [/\binteres (simple|compuesto)/, /tasa de interes/, /\bcapital\b.*\btasa/, /\bmonto\b.*\btasa/] },
    { area: 'aritmetica', id: 'conjuntos', name: 'Conjuntos',
        keywords: [/\bconjuntos?\b/, /\bcardinal\b/, /diagrama de venn/, /producto cartesiano/] },
    { area: 'aritmetica', id: 'promedios', name: 'Promedios',
        keywords: [/\bpromedio/, /media (aritmetica|geometrica|armonica)/] },
    { area: 'aritmetica', id: 'porcentajes', name: 'Porcentajes',
        keywords: [/\bporcentaje/, /por ciento/, /\bdescuentos?\b/, /aumentos? sucesivos?/, /precio de (costo|venta)/] },
    { area: 'aritmetica', id: 'razones-proporciones', name: 'Razones y proporciones',
        keywords: [/\brazon(es)? (aritmetic|geometric)/, /\bproporcion/, /magnitudes? (directa|inversa)/, /regla de tres/] },

    // ------------------------------------------------------------ algebra
    { area: 'algebra', id: 'programacion-lineal', name: 'Programación lineal',
        keywords: [/programacion lineal/, /region factible/, /funcion objetivo/] },
    { area: 'algebra', id: 'inecuaciones', name: 'Inecuaciones',
        keywords: [/\binecuacion/, /\bdesigualdad/, /\bintervalo/] },
    { area: 'algebra', id: 'funciones', name: 'Funciones',
        keywords: [/\bfuncion/, /\bdominio\b/, /\brango\b/, /\bgrafica de/] },
    { area: 'algebra', id: 'polinomios', name: 'Polinomios y factorización',
        keywords: [/\bpolinomio/, /teorema del resto/, /\bruffini/, /\bhorner/, /\bfactorizacion/, /productos notables/, /\bbinomio/] },
    { area: 'algebra', id: 'exponentes-radicales', name: 'Exponentes y radicales',
        keywords: [/\bexponente/, /\bradical/, /raiz (cuadrada|cubica)/, /\bpotenciacion/, /\bradicacion/] },
    { area: 'algebra', id: 'ecuaciones', name: 'Ecuaciones',
        keywords: [/\becuacion/, /sistema de ecuaciones/, /\bcuadratic/, /\bdiscriminante/] },

    // --------------------------------------------------------- geometria
    { area: 'geometria', id: 'solidos', name: 'Sólidos geométricos',
        keywords: [/\bprisma/, /\bpiramide/, /\bcilindro/, /\bcono\b/, /\besfera/, /\bvolumen/, /\bpoliedro/, /\btetraedro/, /\bhexaedro/, /\bparalelepipedo/] },
    { area: 'geometria', id: 'circunferencia', name: 'Circunferencia',
        keywords: [/\bcircunferencia/, /\btangente/, /\bcuerda\b/, /angulo (inscrito|central|semi)/, /\bcirculo/, /sector circular/] },
    { area: 'geometria', id: 'triangulos', name: 'Triángulos',
        keywords: [/\btriangulo/, /\bbisectriz/, /\bmediatriz/, /\bbaricentro/, /\bortocentro/, /\bincentro/, /\bcircuncentro/, /\bpitagor/] },
    { area: 'geometria', id: 'poligonos', name: 'Polígonos y cuadriláteros',
        keywords: [/\bpoligono/, /\bcuadrilatero/, /\bparalelogramo/, /\btrapecio/, /\brombo\b/, /\bcuadrado/, /\brectangulo/, /\bhexagono/, /\bpentagono/] },
    { area: 'geometria', id: 'areas-perimetros', name: 'Áreas y perímetros',
        keywords: [/\bperimetro/, /\barea\b/, /\bareas\b/, /region sombreada/] },

    // ------------------------------------------------------- trigonometria
    { area: 'trigonometria', id: 'resolucion-triangulos', name: 'Resolución de triángulos',
        keywords: [/ley de (senos|cosenos|tangentes)/, /teorema de (senos|cosenos)/, /oblicuangulo/, /resolucion de triangulos/] },
    { area: 'trigonometria', id: 'ecuaciones-trigonometricas', name: 'Ecuaciones trigonométricas',
        keywords: [/ecuacion(es)? trigonometric/, /trigonometricas? inversas?/, /\barc ?(sen|cos|tan)/] },
    { area: 'trigonometria', id: 'identidades', name: 'Identidades trigonométricas',
        keywords: [/\bidentidad/, /angulo (doble|mitad|triple)/, /suma y diferencia de angulos/, /transformacion(es)? trigonometric/] },
    { area: 'trigonometria', id: 'razones', name: 'Razones y funciones trigonométricas',
        keywords: [/razones? trigonometric/, /triangulo rectangulo/, /\bsen\b/, /\bcos\b/, /\btan\b/, /\bcot\b/, /\bsec\b/, /\bcsc\b/, /angulo de (elevacion|depresion)/, /\bseno\b/, /\bcoseno\b/] },

    // -------------------------------------------------------------- fisica
    { area: 'fisica', id: 'vectores', name: 'Vectores',
        keywords: [/\bvector/, /\bresultante\b/, /modulo del vector/, /producto (escalar|vectorial)/] },
    { area: 'fisica', id: 'electricidad', name: 'Electricidad y magnetismo',
        keywords: [/carga electrica/, /campo electrico/, /corriente electrica/, /\bcircuito/, /ley de ohm/, /\bcapacitor/, /\bcondensador/, /\bvoltaje/, /potencial electrico/, /campo magnetico/, /\bmagnetic/, /induccion electromagnetica/] },
    { area: 'fisica', id: 'ondas-optica', name: 'Ondas y óptica',
        keywords: [/\bondas?\b/, /\bsonido/, /\blente/, /\bespejo/, /\brefraccion/, /\breflexion/, /\boptica/, /longitud de onda/, /\bdifraccion/] },
    { area: 'fisica', id: 'calor-termodinamica', name: 'Calor y termodinámica',
        keywords: [/\bcalor\b/, /\btemperatura/, /\btermodinamic/, /\bdilatacion/, /calorimetr/, /gas(es)? ideal/, /\bcelsius/, /\bkelvin/, /capacidad calorifica/] },
    { area: 'fisica', id: 'trabajo-energia', name: 'Trabajo y energía',
        keywords: [/trabajo (mecanico|realizado|neto)/, /energia (cinetica|potencial|mecanica)/, /\bpotencia\b/, /conservacion de la energia/] },
    { area: 'fisica', id: 'estatica', name: 'Estática',
        keywords: [/\bestatica/, /equilibrio (de traslacion|estatico|mecanico)/, /primera condicion/, /segunda condicion/, /momento de (una )?fuerza/, /\btorque/, /diagrama de cuerpo libre/, /\bpalanca/] },
    { area: 'fisica', id: 'dinamica', name: 'Dinámica',
        keywords: [/\bdinamica/, /leyes? de newton/, /segunda ley/, /\brozamiento/, /\bfriccion/, /fuerza centripeta/] },
    { area: 'fisica', id: 'cinematica', name: 'Cinemática',
        keywords: [/\bmruv?\b/, /\bmcuv?\b/, /movimiento (rectilineo|circular|parabolico)/, /caida libre/, /\bvelocidad/, /\baceleracion/, /\bmovil\b/, /\blanzamiento/] },

    // ------------------------------------------------------------- quimica
    { area: 'quimica', id: 'nomenclatura', name: 'Nomenclatura inorgánica',
        keywords: [/\bnomenclatura/, /\boxidos?\b/, /\bhidroxidos?\b/, /\bhidruros?\b/, /\boxisales?\b/, /\bperoxido/, /funcion inorganica/] },
    { area: 'quimica', id: 'electroquimica', name: 'Electroquímica',
        keywords: [/\belectrolisis/, /\bgalvanic/, /\bredox/, /agente (oxidante|reductor)/, /\banodo/, /\bcatodo/, /potencial de reduccion/, /\bfaraday/, /\bpila\b/] },
    { area: 'quimica', id: 'equilibrio', name: 'Equilibrio y cinética',
        keywords: [/equilibrio quimico/, /constante de equilibrio/, /\bkc\b/, /\bkp\b/, /le chatelier/, /cinetica quimica/, /velocidad de reaccion/, /\bcatalizador/, /energia de activacion/] },
    { area: 'quimica', id: 'hidrocarburos', name: 'Química orgánica',
        keywords: [/\bhidrocarburo/, /\balcanos?\b/, /\balquenos?\b/, /\balquinos?\b/, /\bbenceno/, /quimica organica/, /compuestos? organicos?/, /\balcohol/, /\bisomer/, /grupo funcional/, /\baldehido/, /\bcetona/, /\baromatic/] },
    { area: 'quimica', id: 'acidos-bases', name: 'Ácidos y bases',
        keywords: [/\bph\b/, /\bpoh\b/, /\bacidos?\b/, /\bbases?\b/, /neutralizacion/, /\bbronsted/, /\bhidrolisis/, /\bbuffer/, /amortiguad/] },
    { area: 'quimica', id: 'soluciones', name: 'Soluciones',
        keywords: [/\bsolucion/, /\bmolaridad/, /\bnormalidad/, /\bmolalidad/, /\bconcentracion/, /\bsolubilidad/, /\bdilucion/, /\bsoluto/, /\bsolvente/, /\bdisolvente/] },
    { area: 'quimica', id: 'estequiometria', name: 'Estequiometría',
        keywords: [/\bestequiometr/, /\bmol\b/, /\bmoles\b/, /masa molar/, /peso molecular/, /reactivo limitante/, /\brendimiento/, /\bbalanceo/, /numero de avogadro/, /volumen molar/, /leyes? ponderales?/] },
    { area: 'quimica', id: 'enlaces', name: 'Enlace químico',
        keywords: [/enlace (ionico|covalente|metalico|quimico)/, /estructura de lewis/, /geometria molecular/, /\bpolaridad/, /fuerzas intermoleculares/, /puente de hidrogeno/, /\bhibridacion/] },
    { area: 'quimica', id: 'tabla-periodica', name: 'Tabla periódica',
        keywords: [/tabla periodica/, /\belectronegatividad/, /radio atomico/, /energia de ionizacion/, /afinidad electronica/, /\bhalogenos?\b/, /gases nobles/, /\bperiodo\b/] },
    { area: 'quimica', id: 'atomo', name: 'Átomo y configuración electrónica',
        keywords: [/configuracion electronica/, /numeros cuanticos/, /\borbital/, /\bsubnivel/, /numero atomico/, /electrones de valencia/, /\bisotopo/, /\bion\b/, /\batomo\b/] },
    { area: 'quimica', id: 'materia', name: 'Materia y energía',
        keywords: [/\bmateria\b/, /estados? de (la )?materia/, /propiedad(es)? (fisica|quimica|intensiva|extensiva)/, /fenomeno (fisico|quimico)/, /\bdensidad/] },

    // ------------------------------------------------------------ biologia
    { area: 'biologia', id: 'botanica', name: 'Botánica',
        keywords: [/\bplantas?\b/, /\bbotanic/, /\braiz\b/, /\btallo/, /\bhojas?\b/, /\bflor(es)?\b/, /\bfrutos?\b/, /\bsemilla/, /\bangiosperma/, /\bgimnosperma/, /\bxilema/, /\bfloema/, /\bestomas?\b/, /\bpolinizacion/] },
    { area: 'biologia', id: 'sistemas-cuerpo', name: 'Sistemas del cuerpo humano',
        keywords: [/sistema (digestivo|respiratorio|circulatorio|nervioso|endocrino|excretor|urinario|inmunologico|inmune|oseo|muscular|reproductor)/, /\bcorazon/, /\bpulmon/, /\bestomago/, /\bintestino/, /\bhigado/, /\brinon/, /\bneurona/, /\bhormona/, /\bsangre/, /\bhueso/, /\bmusculo/, /\bglandula/, /\bcerebro/, /\bhomeostasis/] },
    { area: 'biologia', id: 'genetica', name: 'Genética',
        keywords: [/\bgenetic/, /\bgenes?\b/, /\balelo/, /\bmendel/, /\bdominante/, /\brecesiv/, /\bfenotipo/, /\bgenotipo/, /\badn\b/, /\barn\b/, /\bmutacion/, /\bherencia/, /\bcodon/, /\btranscripcion/] },
    { area: 'biologia', id: 'celula', name: 'Célula y metabolismo',
        keywords: [/\bcelula/, /\bcelular/, /\bmembrana/, /\borganelo/, /\bmitocondria/, /\bribosoma/, /\bcitoplasma/, /\bmitosis/, /\bmeiosis/, /\bcromosoma/, /\bprocariot/, /\beucariot/, /\bcloroplasto/, /\bfotosintesis/, /respiracion celular/, /\batp\b/, /\benzima/] },
    { area: 'biologia', id: 'ecologia', name: 'Ecología',
        keywords: [/\becolog/, /\becosistema/, /cadena (alimenticia|trofica)/, /nivel trofico/, /\bbioma/, /\bbiodiversidad/, /medio ambiente/, /\bcontaminacion/, /\bsimbiosis/, /\bnicho/, /\bhabitat/, /\bbiosfera/, /piramide (trofica|alimenticia)/] },
    { area: 'biologia', id: 'reinos', name: 'Taxonomía y evolución',
        keywords: [/\breinos?\b/, /\btaxonomia/, /\bbacteria/, /\bhongos?\b/, /\bprotozoo/, /\balgas?\b/, /\bvirus\b/, /\bmoneras?\b/, /\bprotistas?\b/, /\bespecies?\b/, /\binvertebrado/, /\bvertebrado/, /\bartropodo/, /\bmolusco/, /\bmamifero/, /\bevolucion/, /\bdarwin/] },

    // ------------------------------------------------------------ lenguaje
    { area: 'lenguaje', id: 'tildacion', name: 'Tildación y ortografía',
        keywords: [/\btilde/, /\btildacion/, /\bacentuacion/, /\bhiato/, /\bdiptongo/, /\btriptongo/, /\bsilaba/, /palabras? (agudas?|graves?|esdrujulas?|sobresdrujulas?)/, /\bortografia/] },
    { area: 'lenguaje', id: 'puntuacion', name: 'Signos de puntuación',
        keywords: [/\bpuntuacion/, /\bcoma\b/, /punto y coma/, /dos puntos/, /punto seguido/, /\bcomillas/, /\bparentesis/] },
    { area: 'lenguaje', id: 'semantica', name: 'Semántica',
        keywords: [/\bsemantic/, /\bsinonim/, /\bantonim/, /\bpolisemia/, /\bhomonim/, /\bparonim/, /campo (semantico|lexico)/, /\bhiperonimo/, /\bconnotacion/, /\bdenotacion/, /familia lexica/] },
    { area: 'lenguaje', id: 'oracion', name: 'La oración',
        keywords: [/\boracion/, /\bsujeto/, /\bpredicado/, /\bsintagma/, /\bproposicion/, /\bcoordinada/, /\bsubordinada/, /funcion sintactica/, /analisis sintactico/] },
    { area: 'lenguaje', id: 'gramatica', name: 'Categorías gramaticales',
        keywords: [/\bsustantivo/, /\bverbo/, /\badjetivo/, /\badverbio/, /\bpronombre/, /\bpreposicion/, /\bconjuncion/, /categoria gramatical/, /\bmorfolog/, /\bconjugacion/, /tiempo verbal/] },
    { area: 'lenguaje', id: 'comunicacion', name: 'Comunicación y lenguaje',
        keywords: [/elementos de la comunicacion/, /funciones? del lenguaje/, /lengua y habla/, /signo linguistico/, /\bdialecto/, /familia linguistica/, /lenguas? del peru/] },

    // ---------------------------------------------------------- literatura
    { area: 'literatura', id: 'periodos', name: 'Periodos literarios',
        keywords: [/\brenacimiento/, /\bbarroco/, /\bromanticismo/, /\brealismo/, /\bnaturalismo/, /\bmodernismo/, /\bvanguardia/, /\bneoclasicismo/, /\bindigenismo/, /siglo de oro/, /\bedad media/, /\bhumanismo/, /\bcostumbrismo/, /literatura (peruana|universal|espanola|latinoamericana|precolombina|quechua)/, /corriente literaria/] },
    { area: 'literatura', id: 'figuras', name: 'Figuras literarias y verso',
        keywords: [/figuras? (retorica|literaria)/, /\bmetafora/, /\bsimil\b/, /\bhiperbole/, /\bepiteto/, /\bmetonimia/, /\bsinecdoque/, /\banafora/, /\bpersonificacion/, /\bprosopopeya/, /\bparadoja/, /\bironia/, /\bantitesis/, /\bhiperbaton/, /recurso literario/, /\bverso/, /\bestrofa/, /\bmetrica/] },
    { area: 'literatura', id: 'generos', name: 'Géneros literarios',
        keywords: [/genero (lirico|narrativo|dramatico|epico|didactico)/, /generos literarios/, /\bsubgenero/, /\bepopeya/, /\bfabula/, /\bleyenda/, /\bmito\b/, /\bdrama\b/, /\bteatro/, /\bepica\b/, /\blirica\b/, /\bcronica/, /\bensayo/] },
    { area: 'literatura', id: 'obras', name: 'Obras y autores',
        keywords: [/\bobra\b/, /\bnovela/, /\bautor\b/, /\bpoeta/, /\bescritor/, /\bpersonaje/, /\bprotagonista/, /\bnarrador/, /\bcuento/, /\bpoema/] },

    // ------------------------------------------------------------ economia
    { area: 'economia', id: 'oferta-demanda', name: 'Oferta y demanda',
        keywords: [/\boferta/, /\bdemanda/, /precio de equilibrio/, /\belasticidad/, /\bmercado/, /competencia (perfecta|imperfecta)/, /\bmonopolio/, /\boligopolio/] },
    { area: 'economia', id: 'monetario', name: 'Dinero y sistema financiero',
        keywords: [/\bdinero/, /\bmoneda/, /\bbanco/, /\bbancari/, /\binflacion/, /\bbcr\b/, /tasa de (interes|cambio)/, /tipo de cambio/, /\bcredito/, /bolsa de valores/, /sistema (financiero|monetario)/] },
    { area: 'economia', id: 'politica-economica', name: 'Política económica',
        keywords: [/politica (fiscal|monetaria|economica|comercial)/, /\bpbi\b/, /\bpib\b/, /producto bruto/, /\bpresupuesto/, /\bimpuesto/, /\btributo/, /\bsunat/, /\bdeficit/, /balanza (comercial|de pagos)/, /\bexportacion/, /\bimportacion/, /\bdesempleo/, /crecimiento economico/, /\bglobalizacion/] },
    { area: 'economia', id: 'conceptos', name: 'Conceptos económicos básicos',
        keywords: [/\bnecesidad/, /\bbienes?\b/, /\bservicios?\b/, /\bescasez/, /factores? de (la )?produccion/, /\bproduccion/, /\bconsumo/, /costo de oportunidad/, /frontera de posibilidades/, /agentes economicos/, /flujo circular/, /sistemas? economicos?/, /\bmicroeconomia/, /\bmacroeconomia/] },

    // ---------------------------------------------------------- psicologia
    { area: 'psicologia', id: 'procesos-cognitivos', name: 'Procesos cognitivos',
        keywords: [/\batencion/, /\bpercepcion/, /\bmemoria/, /\bpensamiento/, /\binteligencia/, /\baprendizaje/, /\bcognitiv/, /\bimaginacion/, /\bsensacion/] },
    { area: 'psicologia', id: 'personalidad-emociones', name: 'Personalidad y emociones',
        keywords: [/\bpersonalidad/, /\bemocion/, /\bmotivacion/, /\bafectiv/, /\bsentimiento/, /\btemperamento/, /\bfreud/, /\bpsicoanalisis/] },
    { area: 'psicologia', id: 'desarrollo-corrientes', name: 'Desarrollo y corrientes',
        keywords: [/desarrollo (cognitivo|psicosocial|moral)/, /\bpiaget/, /\bvygotsky/, /\bpavlov/, /\bskinner/, /\bwatson/, /\bconductis/, /escuela psicologica/, /\bmaslow/, /\bgestalt/, /objeto de estudio/, /\badolescen/, /\bninez/] },

    // ----------------------------------------------------------- filosofia
    { area: 'filosofia', id: 'antigua-medieval', name: 'Filosofía antigua y medieval',
        keywords: [/\bsocrates/, /\bplaton/, /\baristoteles/, /\bpresocratic/, /\btales\b/, /\bheraclito/, /\bparmenides/, /\bsofista/, /\bescolastic/, /tomas de aquino/, /\bmedieval/] },
    { area: 'filosofia', id: 'moderna-contemporanea', name: 'Filosofía moderna y actual',
        keywords: [/\bdescartes/, /\bkant\b/, /\bhegel/, /\bmarx/, /\bnietzsche/, /\bempirism/, /\bracionalism/, /\bhume\b/, /\bpositivism/, /\bexistencialism/, /\bfenomenolog/, /\bheidegger/, /\bsartre/, /\bpragmatism/, /\bidealism/, /\bmaterialism/] },
    { area: 'filosofia', id: 'ramas', name: 'Ramas de la filosofía',
        keywords: [/\bgnoseolog/, /\bepistemolog/, /\bontolog/, /\bmetafisic/, /\betica\b/, /\bestetica/, /\blogica\b/, /\baxiolog/, /\bmoral\b/, /\bconocimiento/, /\bverdad\b/] },

    // ----------------------------------------------------------- geografia
    { area: 'geografia', id: 'relieve-clima', name: 'Relieve, clima e hidrografía',
        keywords: [/\brelieve/, /\bcordillera/, /\bcuenca/, /\bclima/, /region natural/, /\boceano/, /corriente marina/, /piso altitudinal/, /\bhidrografi/, /\becorregion/, /fenomeno del nino/, /\batmosfera/, /placas? tectonic/, /\bsismo/, /\bvolcan/, /\bcoordenadas/, /\blatitud/, /\blongitud\b/, /husos? horarios?/, /\bcartograf/] },
    { area: 'geografia', id: 'poblacion-territorio', name: 'Población y territorio',
        keywords: [/\bpoblacion/, /\bdepartamento/, /\bprovincia/, /\bfrontera/, /\bdemograf/, /\bmigracion/, /\burbanizacion/, /descentralizacion/, /regionalizacion/, /\bterritorio/, /espacio geografico/] },
    { area: 'geografia', id: 'recursos-ambiente', name: 'Recursos naturales y ambiente',
        keywords: [/\brecursos?\b/, /\bminer/, /\bpesca/, /\bagricultur/, /\bpetroleo/, /calentamiento global/, /cambio climatico/, /\bambiental/, /\bbiodiversidad/, /areas? naturales? protegidas?/, /desarrollo sostenible/] },

    // ----------------------------------------------------- historia del peru
    { area: 'historia-del-peru', id: 'preinca-tahuantinsuyo', name: 'Perú antiguo y Tahuantinsuyo',
        keywords: [/\bpreinca/, /\bchavin/, /\bnazca/, /\bmoche/, /\bwari\b/, /\btiahuanaco/, /\btiwanaku/, /\bchimu/, /\bcaral\b/, /\bsipan/, /\bincas?\b/, /\btahuantinsuyo/, /\bpachacutec/, /\bhuayna capac/, /\bhuascar/, /\batahualpa/, /\bayllu/, /\bquipu/, /\bhorizonte/] },
    { area: 'historia-del-peru', id: 'conquista-virreinato', name: 'Conquista y Virreinato',
        keywords: [/\bconquista/, /\bpizarro/, /\balmagro/, /\bvirrein/, /\bvirrey/, /\bcolonia/, /\bencomienda/, /\bcorregimiento/, /\bcorregidor/, /consejo de indias/, /\btupac amaru/, /reformas borbonicas/] },
    { area: 'historia-del-peru', id: 'republica', name: 'Perú republicano',
        keywords: [/\bindependencia/, /san martin/, /\bbolivar/, /\brepublica/, /\bcaudillismo/, /guerra (con chile|del pacifico)/, /\bcastilla\b/, /\bcivilismo/, /\bleguia/, /\bguano/, /confederacion/, /\bcaceres/, /\bbelaunde/, /\bvelasco/, /\bfujimori/, /gobierno militar/, /\bapra\b/, /conflicto armado/] },

    // ---------------------------------------------------- historia universal
    { area: 'historia-universal', id: 'antiguedad-edad-media', name: 'Antigüedad y Edad Media',
        keywords: [/\bmesopotamia/, /\begipto/, /\bgrecia/, /\bimperio romano/, /\broma\b/, /\bfeudal/, /\bmedieval/, /edad media/, /\bcruzadas?\b/, /\bbizanti/, /\bislam/, /\bfenicios/, /\bpersia/, /\bprehistoria/, /\bpaleolitico/, /\bneolitico/, /\bcarlomagno/, /\bantiguedad/] },
    { area: 'historia-universal', id: 'edad-moderna', name: 'Edad Moderna',
        keywords: [/\brenacimiento/, /\breforma\b/, /\bilustracion/, /revolucion francesa/, /\babsolutismo/, /\bdescubrimiento/, /\bhumanismo/, /\bmercantilismo/, /revolucion industrial/, /\bnapoleon/, /edad moderna/] },
    { area: 'historia-universal', id: 'edad-contemporanea', name: 'Edad Contemporánea',
        keywords: [/primera guerra/, /segunda guerra/, /guerra fria/, /revolucion (rusa|china|cubana)/, /\bfascismo/, /\bnazismo/, /nacionalsocialismo/, /\bcapitalismo/, /\bcomunismo/, /\bimperialismo/, /crisis de 1929/, /\bonu\b/, /\bdescolonizacion/, /\bcontemporane/] },
];
