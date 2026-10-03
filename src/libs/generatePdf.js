import puppeteer from "puppeteer";
import fs from "fs";
import { base64url } from "jose";
import handlebars from "handlebars";
import { PDFDocument } from "pdf-lib";

const generate = async ({ layout, title, data, hideHeaderFooter = false }) => {
    const logoB64 = fs.readFileSync('./src/public/images/logo_eduteka.png', {encoding:'base64'});
    const company = "Eduteka";

    const config = {
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
    };

    const localChromePath = 'E:\\Trabajo\\eduteka\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe';
    if (fs.existsSync(localChromePath)) {
        config.executablePath = localChromePath;
    }

    if ( process.env.MODE === "PRODUCTION" ) {
        config.executablePath = '/usr/bin/chromium-browser';
        config.args = ["--no-sandbox"];
    }

    const source = fs.readFileSync( layout , 'utf-8');
    const templateCompiled = handlebars.compile(source);
    const hbs = templateCompiled(data);

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();

    await page.setContent(hbs, {
        timeout: 0,
        waitUntil: "load",
    });

    const headerHtml = `
        <table style="width:100%;margin-top: -10px; margin-left: 18px; margin-right: 18px; border-bottom-style: solid; border-bottom-color: black; border-bottom-width: 1px; " >
        <tr style="width: 100%;" >
            <td style="width:91%;color:#676666;" width="50%" >
            <span style="font-size:13px;">${title}</span>
            </td>
            <td style="width:9%" style="text-align:right;" >
                <img src="data:image/png;base64,${logoB64}" style="height:20px;"/>
            </td>
        </tr>
        </table>`;

    const footerHtml = `
        <table style="width:100%; margin-left: 18px;margin-bottom:-10px; margin-right: 18px; border-top-style: solid; border-top-color: black; border-top-width: 1px; " >
        <tr style="width: 100%;" >
            <td style="width:70%;color:#676666;" width="70%" >
            <span style="font-size:10px;"><span style="font-weight:bold;">Elaborado en la plataforma <a href="${process.env.WEB_URL}">eduteka.pe</a></span> </span>
            </td>
            <td style="width:28%" style="text-align:end;"></td>
            <td style="width:2%" style="text-align:end;" >
            <span class="pageNumber" style="font-size:10px;" ></span><span style="font-size: 10px;"  >/</span><span class="totalPages" style="font-size:10px;" ></span>
            </td>
        </tr>
        </table>`;

    const pdf = await page.pdf({
        preferCSSPageSize: true,
        timeout: 0,
        format: "A4",
        printBackground: true,
        headerTemplate: hideHeaderFooter ? '<div></div>' : headerHtml,
        footerTemplate: hideHeaderFooter ? '<div></div>' : footerHtml,
        displayHeaderFooter: !hideHeaderFooter,
        margin: hideHeaderFooter ? {
            left: "0.5cm",
            top: "0.5cm",
            right: "0.5cm",
            bottom: "0.5cm"
        } : {
            left: "0.5cm",
            top: "40px",
            right: "0.5cm",
            bottom: "40px"
        },
    });

    await page.close();
    await browser.close();
    return pdf;
}

const mergePDFs = async (pdfBuffers) => {
    const mergedPdf = await PDFDocument.create();
    for (const pdfBuffer of pdfBuffers) {
        if (!pdfBuffer) continue;
        const pdf = await PDFDocument.load(pdfBuffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const mergedPdfFile = await mergedPdf.save();
    return Buffer.from(mergedPdfFile);
};

export { generate, mergePDFs };
