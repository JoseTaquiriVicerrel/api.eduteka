const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }; // fecha literal string

const format_date = (date, hora = false) => {

    const newFecha = new Date(date);
    let fecha = newFecha.toLocaleDateString(undefined,  { timeZone: 'America/Lima', year: 'numeric', month: 'numeric', day: 'numeric' });

    if (hora) {
        // fecha += " " + newFecha.toLocaleTimeString("en-ES", { hour: 'numeric', minute: '2-digit', hour12: true });
        fecha += " " + newFecha.toLocaleTimeString( undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
        return fecha;
    }
    return fecha;
}

export { format_date };