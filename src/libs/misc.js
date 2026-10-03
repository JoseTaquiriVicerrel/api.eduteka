const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }; // fecha literal string

const format_date = (date, hora = false,) => {

    const newFecha = new Date(date);
    let fecha = newFecha.toLocaleDateString('es-ES',  { timeZone: 'America/Lima', year: 'numeric', month: 'numeric', day: 'numeric' });

    if (hora) {
        // fecha += " " + newFecha.toLocaleTimeString("en-ES", { hour: 'numeric', minute: '2-digit', hour12: true });
        fecha += " " + newFecha.toLocaleTimeString( 'es-ES', { hour: 'numeric', minute: '2-digit', hour12: true });
        return fecha;
    }
    return fecha;
}

const formatDateString = (date) => {
    const newFecha = new Date( date );
    newFecha.setHours(newFecha.getHours() + 5);
    // const newFecha = new Date( oldFecha.getFullYear(),oldFecha.getMonth(),oldFecha.getDate() ); 
    // console.log("fecha",oldFecha,newFecha);
    // console.log("Date", newFecha.toLocaleDateString('es-ES',  { timeZone: 'America/Lima', year: 'numeric', month: 'numeric', day: 'numeric' }));
    // console.log("Time", newFecha.toLocaleTimeString( 'es-ES', { hour: 'numeric', minute: '2-digit', hour12: true }));
    
    return newFecha.toLocaleDateString('es-ES',  { timeZone: 'America/Lima', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
}

const formatShowDate = (date) => {
    const d = new Date(date);
    d.setHours(d.getHours() + 5);

    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    const year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    return [year, month, day].join('-');
};

export { format_date , formatDateString, formatShowDate };
