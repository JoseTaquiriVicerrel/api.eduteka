// Envelope de respuesta de la API (especificacion §3.1). Ningun controlador
// llama a `res.json` directamente: todo pasa por aqui.
//
//   exito: { data, meta? }
//   error: { error: { code, message, details? }, request_id }

export const ok = (res, data, meta) => {
    const body = { data };
    if (meta) body.meta = meta;
    return res.status(200).json(body);
};

export const created = (res, data) => res.status(201).json({ data });

export const noContent = (res) => res.status(204).end();

export const errorBody = (req, { code, message, details }) => {
    const error = { code, message };
    if (details) error.details = details;
    return { error, request_id: req.id };
};
