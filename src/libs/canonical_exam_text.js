export const canonicalExamText = (parsedJson) => {
    if (!parsedJson || !Array.isArray(parsedJson.areas)) return '';
    let lines = [];

    for (const area of parsedJson.areas) {
        if (area.name) {
            lines.push(area.name.toUpperCase());
        }
        if (Array.isArray(area.items)) {
            for (const item of area.items) {
                if (item.type === 'block') {
                    if (item.text) {
                        lines.push(item.text);
                    }
                } else if (item.type === 'question') {
                    const qNum = item.number ? `PREGUNTA ${item.number}.` : 'PREGUNTA.';
                    lines.push(`${qNum} ${item.question || ''}`);
                    if (Array.isArray(item.options)) {
                        for (const opt of item.options) {
                            const correctMark = opt.is_correct ? '*' : '';
                            lines.push(`${opt.letter}) ${opt.text}${correctMark}`);
                        }
                    }
                    if (item.resolution) {
                        lines.push(`SOLUCIÓN:\n${item.resolution}`);
                    }
                }
            }
        }
    }
    return lines.join('\n');
};
