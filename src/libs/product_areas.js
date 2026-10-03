/**
 * Construye la lista de areas seleccionables de un producto para la UI y para
 * validar el pedido en el servidor.
 *
 * Existe para cerrar de raiz el bug de "ningun area marcada por defecto": antes
 * la plantilla decidia el `checked` comparando `area_exam` (clave del mapa)
 * contra `area.abrev` (campo guardado) y solo pintaba las areas `verified`, asi
 * que bastaba con que la primera area no estuviera verificada -o con que fuera
 * un examen UNICO recien creado, que nace sin `verified`- para que el usuario
 * no pudiera comprar. Ahora la plantilla solo itera: toda la decision vive aca.
 *
 * Garantiza SIEMPRE al menos un elemento y exactamente uno con `checked: true`.
 *
 * Sobre `abrev` vs `label`: la identidad de un area es la CLAVE del mapa, porque
 * es la que guarda `product.files[].area` y contra la que compara el control de
 * acceso de la descarga. El campo `abrev` del documento es editable sin
 * renombrar la clave, asi que solo sirve para mostrar.
 */

// Mismas etiquetas que `areaSlug` en #Libs/functions.js trata como area unica.
const SINGLE_AREA_KEYS = new Set(['UNICO', '0', 'I', 'O', 'TODAS']);

const isSingleAreaKey = (key) => SINGLE_AREA_KEYS.has(String(key ?? '').toUpperCase());

const toEntry = (key, area) => ({
    abrev: String(key),
    label: String(area?.abrev || key),
    title: area?.title || String(key),
    description: area?.description || '',
    verified: Boolean(area?.verified),
});

// Producto sin mapa de areas (materiales, o exámenes mal migrados): se le da un
// area sintetica para que cuente como una unidad de precio. Sin esto el total
// del item queda en 0 y el producto sale gratis.
const fallbackEntry = () => ({
    abrev: 'UNICO',
    label: 'UNICO',
    title: 'Único',
    description: '',
    verified: true,
});

/**
 * @param {object} product documento de Product (lean o mongoose)
 * @param {string} [preferred] area a preseleccionar (clave o abrev mostrado)
 * @returns {Array<{abrev,label,title,description,verified,checked,locked}>}
 */
const buildSelectableAreas = (product, preferred) => {
    const areasMap = product?.areas && typeof product.areas === 'object' ? product.areas : {};
    const allEntries = Object.keys(areasMap).map((key) => toEntry(key, areasMap[key]));

    let entries;

    if (product?.unique) {
        // Examen unico: una sola opcion. Se busca la clave centinela y si no
        // aparece se usa la primera disponible.
        entries = [
            allEntries.find((entry) => isSingleAreaKey(entry.abrev) || isSingleAreaKey(entry.label))
                || allEntries[0]
                || fallbackEntry(),
        ];
    } else if (allEntries.length === 0) {
        entries = [fallbackEntry()];
    } else {
        const verified = allEntries.filter((entry) => entry.verified);
        // Si ninguna area esta verificada se ofrecen todas: es preferible vender
        // el examen a dejar el modal sin ninguna casilla que marcar.
        entries = verified.length > 0 ? verified : allEntries;
    }

    const locked = entries.length === 1;
    const wanted = String(preferred ?? '');
    const preferredIndex = entries.findIndex((entry) => entry.abrev === wanted || entry.label === wanted);
    const checkedIndex = preferredIndex >= 0 ? preferredIndex : 0;

    return entries.map((entry, index) => ({
        ...entry,
        checked: index === checkedIndex,
        locked,
    }));
};

/**
 * Normaliza las areas que manda el cliente contra el catalogo real del producto.
 * Devuelve solo las areas validas, y si no queda ninguna cae en la marcada por
 * defecto, de modo que un pedido nunca llega con 0 areas (= importe 0).
 *
 * @returns {Array<{abrev,title,description}>}
 */
const resolveOrderAreas = (product, requestedAreas = []) => {
    const selectable = buildSelectableAreas(product);
    const requested = (Array.isArray(requestedAreas) ? requestedAreas : [])
        .map((area) => String(typeof area === 'string' ? area : (area?.abrev ?? '')).trim())
        .filter(Boolean);

    const wanted = new Set(requested);
    let matched = selectable.filter((entry) => wanted.has(entry.abrev) || wanted.has(entry.label));

    // Producto de area unica: se compra completo, sin importar lo que llegue.
    if (product?.unique || selectable.length === 1) matched = selectable;
    if (matched.length === 0) matched = selectable.filter((entry) => entry.checked);

    return matched.map(({ abrev, title, description }) => ({ abrev, title, description }));
};

export { buildSelectableAreas, resolveOrderAreas, isSingleAreaKey };
export default buildSelectableAreas;
