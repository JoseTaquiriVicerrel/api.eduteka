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

const paginateDocs = (data, page = 1, pageSize = 20, total, maxPages = 5, url, params ) => {

    const pagination = {};
    console.log("params", params);
    pagination.page = page;
    // pagination.limit = pageSize;
    pagination.page_size = pageSize;
    pagination.total = total;
    pagination.total_pages = Math.ceil(total / pageSize);
    pagination.pages = [];
    pagination.start = page === 1 ? 1 : (page - 1) * pageSize;
    pagination.end = ((pageSize * page) < total) ? page * pageSize : total;
    pagination.prev = {};
    pagination.next = {};

    const margen = Math.trunc( maxPages / 2 );

    maxPages = pagination.total_pages > (maxPages + margen) ? maxPages : (maxPages + margen);
    // cuando la cantidad de paginas es mayor al maximo de paginas
    console.log("maxPages", maxPages);
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
                console.log("resto", margen);
                console.log("total pages", pagination.total_pages);
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

export { paginate,paginateDocs }