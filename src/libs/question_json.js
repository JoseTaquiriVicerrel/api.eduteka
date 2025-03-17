import { JSDOM } from "jsdom";

function htmlToJson(html) {
    const dom = new JSDOM(`<body>${html}</body>`); // Envolver en <body> para parsear
    const body = dom.window.document.body;

    function parseNode(node) {
        if (node.nodeType === 3) { // Nodo de texto
            let text = node.textContent.trim();

            // Detectar y extraer fórmulas matemáticas con \[ ... \]
            const formulaRegex = /\\\[(.*?)\\\]/g;
            let matches = [...text.matchAll(formulaRegex)];

            if (matches.length > 0) {
                let contentArray = [];
                let lastIndex = 0;

                matches.forEach(match => {
                    let beforeText = text.substring(lastIndex, match.index);
                    console.log(beforeText);
                    if (beforeText) contentArray.push({ type: "text", content: beforeText });

                    contentArray.push({ type: "formula", content: match[1].trim() });
                    lastIndex = match.index + match[0].length;
                });


                let afterText = text.substring(lastIndex).trim();

                console.log(afterText);
                if (afterText) contentArray.push({ type: "text", content: afterText });

                return contentArray.length ? contentArray : null;
            }

            return text ? { type: "text", content: text } : null;
        } else if (node.nodeType === 1) { // Nodo de etiqueta HTML
            if (node.tagName.toLowerCase() === "img") {
                return { type: "image", src: node.getAttribute("src") || "" };
            }

            const item = { type: node.tagName.toLowerCase(), content: [] };
            node.childNodes.forEach(child => {
                const parsedChild = parseNode(child);
                if (parsedChild) {
                    if (Array.isArray(parsedChild)) {
                        item.content.push(...parsedChild);
                    } else {
                        item.content.push(parsedChild);
                    }
                }
            });

            return item.content.length ? item : null;
        }
        return null;
    }

    let result = [];

    body.childNodes.forEach(node => {
        const parsed = parseNode(node);
        if (parsed) {
            if (Array.isArray(parsed)) {
                result.push(...parsed);
            } else {
                result.push(parsed);
            }
        }
    });

    return JSON.stringify(result, null, 2);
}



// Ejemplo de uso
// const html = `
//     <p>En la gráfica, se muestra la recta tangente \\[g(x) = 2x + m\\] a la parábola \\[f(x) = x^2 - 4x + 4\\], determina el valor de "m".</p>
//     <p><img src="/images/questions/img_matematica_325d743c.png"></p>
// `;

// // console.log(htmlToJson(html));
// console.log(htmlToJson2(html));
export default { htmlToJson };