// DOCX -> PDF (material del docente). Port de eduteka/src/services/docx/docx-to-pdf.service.js.
//
// LibreOffice en modo sin ventana es lo unico que respeta lo que lleva un material (formulas OMML,
// columnas, bordes, listas numeradas) sin mandar el documento a un tercero. En desarrollo, si no
// esta y hay Word (Windows), se usa Word por COM; en produccion nunca.
//
// Una conversion a la vez: LibreOffice se come un nucleo y cientos de MB por documento. Cada una usa
// su propio perfil de usuario (con el compartido, una segunda instancia se niega a arrancar).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settings } from '#Config/settings.js';

export class DocxEngineUnavailableError extends Error {
    constructor() {
        super('No hay motor para convertir DOCX a PDF (instala LibreOffice o define LIBREOFFICE_PATH)');
        this.name = 'DocxEngineUnavailableError';
    }
}

const LIBREOFFICE_CANDIDATES = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];
const WORD_CANDIDATES = [
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
];

/** Motor disponible: { name: 'libreoffice' | 'word', bin } o null. */
export const findDocxEngine = ({ libreOfficePath = settings.docs.libreOfficePath, isProduction = settings.isProduction } = {}) => {
    const soffice = [libreOfficePath, ...LIBREOFFICE_CANDIDATES].find((candidate) => candidate && fs.existsSync(candidate));
    if (soffice) return { name: 'libreoffice', bin: soffice };
    if (!isProduction && process.platform === 'win32' && WORD_CANDIDATES.some((candidate) => fs.existsSync(candidate))) {
        return { name: 'word', bin: 'powershell.exe' };
    }
    return null;
};

const run = (bin, args, options = {}) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: settings.docs.timeoutMs, windowsHide: true, ...options }, (error, stdout, stderr) => {
        if (error) {
            error.message += stderr ? ` | ${String(stderr).trim()}` : '';
            return reject(error);
        }
        return resolve(stdout);
    });
});

const convertWithLibreOffice = async (bin, workDir, input) => {
    await run(bin, [
        '--headless', '--norestore', '--nologo', '--nolockcheck',
        `-env:UserInstallation=${pathToFileURL(path.join(workDir, 'profile')).href}`,
        '--convert-to', 'pdf',
        '--outdir', workDir,
        input,
    ]);
};

// Las rutas viajan en variables de entorno y no dentro del script: nada de lo que hay en un nombre
// de archivo llega a interpretarse como PowerShell.
const WORD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($env:EDK_DOCX_IN, $false, $true)
  $doc.SaveAs2($env:EDK_PDF_OUT, 17)
  $doc.Close(0)
} finally { $word.Quit() }
`;

const convertWithWord = (input, output) => run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(WORD_SCRIPT, 'utf16le').toString('base64'),
], { env: { ...process.env, EDK_DOCX_IN: path.resolve(input), EDK_PDF_OUT: path.resolve(output) } });

let chain = Promise.resolve();

/**
 * Convierte el .docx (Buffer) y devuelve el PDF (Buffer). Todo ocurre en una carpeta temporal que
 * se borra siempre. `engine` se puede inyectar (pruebas).
 */
export const convertDocx = (docxBuffer, { engine = findDocxEngine(), convert } = {}) => {
    if (!engine && !convert) return Promise.reject(new DocxEngineUnavailableError());

    const job = chain.then(async () => {
        const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edk-docx-'));
        try {
            const input = path.join(workDir, 'material.docx');
            const output = path.join(workDir, 'material.pdf');
            await fsp.writeFile(input, docxBuffer);

            if (convert) await convert(input, output);
            else if (engine.name === 'libreoffice') await convertWithLibreOffice(engine.bin, workDir, input);
            else await convertWithWord(input, output);

            if (!fs.existsSync(output)) throw new Error(`${engine?.name ?? 'El conversor'} no produjo el PDF`);
            return await fsp.readFile(output);
        } finally {
            await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });
    // La cola sigue aunque esta conversion falle.
    chain = job.catch(() => {});
    return job;
};
