// HTML -> PDF A4 con la cabecera, el pie y la marca de agua de Eduteka.
//
// Port de la impresion de eduteka/src/libs/generatePdf.js (cabecera con barra verde, titulo y logo;
// pie "Elaborado en la plataforma Eduteka", numero de pagina; marca de agua con pdf-lib). El HTML
// llega YA armado: la plantilla compilada y las imagenes y fuentes incrustadas en base64 los pone
// quien lo pide, que es quien tiene las plantillas y los archivos.

import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { settings } from '#Config/settings.js';

const LOGO_PNG = fs.readFileSync(new URL('../../assets/logo_eduteka.png', import.meta.url));
const LOGO_B64 = LOGO_PNG.toString('base64');
const BRAND_GREEN = '#00BF63';
const INK_STRONG = '#3F4254';
const INK_MUTED = '#5E6278';
const LINE_SOFT = '#B5B5C3';

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const headerHtml = (title) => `
    <div style="width:calc(100% - 36px); margin: -10px 18px 0; padding-bottom: 4px; display:flex; align-items:center; border-bottom: 1px solid ${LINE_SOFT}; font-family: Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact;">
        <div style="width:4px; height:16px; background:${BRAND_GREEN}; margin-right:8px;"></div>
        <div style="flex:1; color:${INK_STRONG}; font-size:12px;">${escapeHtml(title)}</div>
        <img src="data:image/png;base64,${LOGO_B64}" style="height:18px;"/>
    </div>`;

const footerHtml = (webUrl) => `
    <div style="width:calc(100% - 36px); margin: 0 18px -10px; padding-top: 4px; display:flex; align-items:center; border-top: 1px solid ${LINE_SOFT}; font-family: Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact;">
        <div style="width:28px;"></div>
        <div style="flex:1; text-align:center; color:${INK_MUTED}; font-size:9px;">
            <span style="font-style:italic;">Elaborado en la plataforma Eduteka</span> · <a href="${escapeHtml(webUrl)}" style="color:${BRAND_GREEN}; font-weight:bold; text-decoration:none;">eduteka.pe</a>
        </div>
        <div style="width:28px; text-align:center; background:${BRAND_GREEN}; color:#fff; font-size:10px; font-weight:bold; padding:3px 0; border-radius:0.3rem;"><span class="pageNumber"></span></div>
    </div>`;

/** Marca de agua en cada pagina: logo translucido y "eduteka.pe" (no se quita ocultando un fondo CSS). */
export const addWatermark = async (pdfBuffer) => {
    const pdf = await PDFDocument.load(pdfBuffer);
    const logo = await pdf.embedPng(LOGO_PNG);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const label = 'eduteka.pe';

    for (const page of pdf.getPages()) {
        const { width, height } = page.getSize();
        const logoW = width * 0.6;
        const logoH = logoW * logo.height / logo.width;
        const labelSize = logoH * 0.3;
        const labelW = font.widthOfTextAtSize(label, labelSize);
        const blockH = logoH + labelSize * 1.6;
        const top = (height + blockH) / 2;

        page.drawImage(logo, { x: (width - logoW) / 2, y: top - logoH, width: logoW, height: logoH, opacity: 0.08 });
        page.drawText(label, { x: (width - labelW) / 2, y: top - blockH, size: labelSize, font, color: rgb(126 / 255, 130 / 255, 153 / 255), opacity: 0.1 });
    }
    return Buffer.from(await pdf.save());
};

export const pageCount = async (pdfBuffer) => (await PDFDocument.load(pdfBuffer)).getPageCount();

/**
 * Imprime `html` en una pagina del navegador compartido (ver ./chromium.js).
 * Devuelve el PDF como Buffer.
 */
export const printHtml = async (browserManager, html, {
    title = '', headerFooter = true, watermark = headerFooter, webUrl = settings.app.webUrl ?? 'https://eduteka.pe',
    timeoutMs = settings.docs.timeoutMs, selfContained = false,
} = {}) => {
    const pdf = await browserManager.withPage(async (page) => {
        if (selfContained) {
            // HTML autocontenido (lo arma la API): sin JavaScript y sin red. Es la defensa que no depende de
            // haber limpiado bien el HTML de las preguntas (scripts, iframes, hojas de estilo remotas).
            await page.setJavaScriptEnabled(false);
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const url = request.url();
                return url.startsWith('data:') || url === 'about:blank' ? request.continue() : request.abort();
            });
        }
        // El HTML no necesita red: todo viene incrustado. Lo que pida igual (un CDN olvidado) se corta
        // a los `timeoutMs` en vez de colgar la impresion.
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        return page.pdf({
            preferCSSPageSize: true,
            timeout: timeoutMs,
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: headerFooter,
            headerTemplate: headerFooter ? headerHtml(title) : '<div></div>',
            footerTemplate: headerFooter ? footerHtml(webUrl) : '<div></div>',
            margin: headerFooter
                ? { left: '0.5cm', top: '40px', right: '0.5cm', bottom: '40px' }
                : { left: '0.5cm', top: '0.5cm', right: '0.5cm', bottom: '0.5cm' },
        });
    });
    const buffer = Buffer.from(pdf);
    return watermark ? addWatermark(buffer) : buffer;
};
