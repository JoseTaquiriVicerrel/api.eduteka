const paginate = (data, pageNum, page_size) => {

    const page = pageNum ?? 1;
    const pageSize = page_size ?? 5;

    const start = (page - 1) * pageSize;
    const end = ((pageSize * page) < data.length) ? page * pageSize : data.length;
    const items = data.slice(start, end);
    const total = data.length;
    const totalPages = Math.ceil(total / pageSize)

    const countRegister = (end - start);
    return {
        'status': true,
        'items': items, "page": page, "start": start, "end": end, "page_size": countRegister, "total": total, "total_pages": totalPages
    }

}

const paginateSync = (data, pageNum = 1, pageSize = 15) => {

    const info = {};
    let items = 0;
    info.page = pageNum ?? 1;
    info.pageSize = pageSize ?? 15;
    info.total = data.length;

    // `offset` es el indice (desde 0) con el que se recorta; `start` es el mismo
    // registro contado desde 1, solo para mostrar. Antes eran un unico valor y la
    // pagina 1 recortaba desde el indice 1: se saltaba el primer registro.
    const offset = (info.page - 1) * info.pageSize;
    info.start = info.total > 0 ? offset + 1 : 0;
    info.end = ((info.pageSize * info.page) < info.total) ? info.page * info.pageSize : info.total;

    items = data.slice(offset, info.end);

    info.totalPages = Math.ceil(info.total / info.pageSize)
    info.next_page = info.page < info.totalPages ? info.page + 1 : null;
    info.countRegister = items.length;

    return { info, items };

}

const paginateAsync = (data, page = 1, pageSize = 20, maxPages = 5 ) => {

    let items = 0;

    const pagination = {};
    pagination.page = page;
    pagination.page_size = pageSize;
    pagination.total = data.length;
    pagination.total_pages = Math.ceil(pagination.total / pageSize);
    pagination.pages = [];
    // `offset` recorta (desde 0); `start` es el primer registro contado desde 1,
    // solo para mostrar ("Mostrando 21 - 40"). Antes `start` hacia las dos cosas
    // y en pantalla la pagina 2 decia "20 - 40".
    const offset = (page - 1) * pageSize;
    pagination.start = pagination.total > 0 ? offset + 1 : 0;
    pagination.end = ((pageSize * page) < pagination.total) ? page * pageSize : pagination.total;
    pagination.prev = {};
    pagination.next = {};

    items = data.slice(offset, pagination.end);

    const margen = Math.trunc( maxPages / 2 );
    maxPages = pagination.total_pages > (maxPages + margen) ? maxPages : (maxPages + margen);

    // cuando la cantidad de paginas es mayor al maximo de paginas
    // console.log("maxPages", maxPages);

    if ( pagination.total_pages > maxPages ) {

        //  cuando la pagina actual es menor que el maximo de paginas a mostrar
        if ( page < (maxPages + (margen * 2)) ) {

            for (let index = 1; index <= (maxPages + (margen * 2)) ; index++) {
                pagination.pages.push({
                    state: index === page ? 'active' : '',
                    page: index,
                });
            }

            pagination.pages.push({
                type: 'separator'
            });

            pagination.pages.push({
                page: pagination.total_pages,
            });

        } else if (page <= (pagination.total_pages - maxPages)) {
            pagination.pages.push({
                page: 1,
            });
            pagination.pages.push({
                type: 'separator'
            });

            if ((page + margen) < pagination.total_pages) {
                // console.log("resto", margen);
                // console.log("total pages", pagination.total_pages);
                for (let index = page - margen; index <= page + margen; index++) {
                    pagination.pages.push({
                        state: index === page ? 'active' : '',
                        page: index,
                    });
                }

                pagination.pages.push({
                    type: 'separator'
                });
                pagination.pages.push({
                    page: pagination.total_pages,
                });
            } else {
                for (let index = page; index <= pagination.total_pages; index++) {
                    pagination.pages.push({
                        state: index === page ? 'active' : '',
                        page: index,
                    });
                }

            }

        } else {
            pagination.pages.push({
                page: 1,
            });
            pagination.pages.push({
                type: 'separator'
            });
            for (let index = (pagination.total_pages - maxPages); index <= pagination.total_pages; index++) {
                pagination.pages.push({
                    state: index === page ? 'active' : '',
                    page: index,
                });
            }
        }

    } else {
        for (let index = 1; index <= pagination.total_pages; index++) {
            pagination.pages.push({
                state: index === page ? 'active' : '',
                page: index,
            });
        }
    }

    if (page === 1) {
        pagination.prev.state = 'disabled';
        pagination.prev.to_page = '';
    } else {
        pagination.prev.state = '';
        pagination.prev.to_page = page - 1;
    }

    if (page === pagination.total_pages) {
        pagination.next.state = 'disabled';
        pagination.next.to_page = '';
    } else {
        pagination.next.state = '';
        pagination.next.to_page = page + 1;
    }

    return {
        info: pagination,
        items
    }
}

const paginateDocs = (data, page = 1, pageSize = 20, total, maxPages = 5, url, params ) => {

    const pagination = {};
    // console.log("params", params);
    pagination.page = page;
    // pagination.limit = pageSize;
    pagination.page_size = pageSize;
    pagination.total = total;
    pagination.total_pages = Math.ceil(total / pageSize);
    pagination.pages = [];
    // Primer registro de la pagina, contado desde 1: solo se muestra ("Mostrando
    // 16 - 30"), `data` ya llega recortado. Antes la pagina 2 decia "15 - 30".
    pagination.start = total > 0 ? (page - 1) * pageSize + 1 : 0;
    pagination.end = ((pageSize * page) < total) ? page * pageSize : total;
    pagination.prev = {};
    pagination.next = {};

    const margen = Math.trunc( maxPages / 2 );

    maxPages = pagination.total_pages > (maxPages + margen) ? maxPages : (maxPages + margen);
    // cuando la cantidad de paginas es mayor al maximo de paginas
    // console.log("maxPages", maxPages);
    if ( pagination.total_pages > maxPages ) {

        //  cuando la pagina actual es menor que el maximo de paginas a mostrar
        if ( page < (maxPages + (margen * 2)) ) {

            for (let index = 1; index <= (maxPages + (margen * 2)) ; index++) {
                params.page = index;
                pagination.pages.push({
                    state: index === page ? 'active' : '',
                    page: index,
                    url: url + '?' + (new URLSearchParams(params)).toString()
                });
            }

            pagination.pages.push({
                type: 'separator'
            });

            params.page = pagination.total_pages;
            pagination.pages.push({
                page: pagination.total_pages,
                url: url + '?' + (new URLSearchParams(params)).toString()
            });

        } else if (page <= (pagination.total_pages - maxPages)) {
            params.page = 1;
            pagination.pages.push({
                page: 1,
                url: url + '?' + (new URLSearchParams(params)).toString()
            });
            pagination.pages.push({
                type: 'separator'
            });

            if ((page + margen) < pagination.total_pages) {

                // console.log("resto", margen);
                // console.log("total pages", pagination.total_pages);

                for (let index = page - margen; index <= page + margen; index++) {
                    params.page = index;
                    pagination.pages.push({
                        state: index === page ? 'active' : '',
                        page: index,
                        url: url + '?' + (new URLSearchParams(params)).toString()
                    });
                }

                pagination.pages.push({
                    type: 'separator'
                });
                params.page = pagination.total_pages;
                pagination.pages.push({
                    page: pagination.total_pages,
                    url: url + '?' + (new URLSearchParams(params)).toString()
                });
            } else {
                for (let index = page; index <= pagination.total_pages; index++) {
                    params.page = index;
                    pagination.pages.push({
                        state: index === page ? 'active' : '',
                        page: index,
                        url: url + '?' + (new URLSearchParams(params)).toString()
                    });
                }
            }

        } else {
            params.page = 1;
            pagination.pages.push({
                page: 1,
                url: url + '?' + (new URLSearchParams(params)).toString()
            });
            pagination.pages.push({
                type: 'separator'
            });
            for (let index = (pagination.total_pages - maxPages); index <= pagination.total_pages; index++) {
                params.page = index;
                pagination.pages.push({
                    state: index === page ? 'active' : '',
                    page: index,
                    url: url + '?' + (new URLSearchParams(params)).toString()
                });
            }
        }

    } else {
        for (let index = 1; index <= pagination.total_pages; index++) {
            params.page = index;
            pagination.pages.push({
                state: index === page ? 'active' : '',
                page: index,
                url: url + '?' + (new URLSearchParams(params)).toString()
            });
        }
    }

    if (page === 1) {
        pagination.prev.state = 'disabled';
        pagination.prev.url = '';
    } else {
        pagination.prev.state = '';
        params.page = page - 1;
        pagination.prev.url = url + '?' + (new URLSearchParams(params)).toString();
    }

    if (page === pagination.total_pages) {
        pagination.next.state = 'disabled';
        pagination.next.url = '';
    } else {
        pagination.next.state = '';
        params.page = page + 1;
        pagination.next.url = url + '?' + (new URLSearchParams(params)).toString();
    }

    return pagination;
}

export { paginate,paginateDocs, paginateSync, paginateAsync }