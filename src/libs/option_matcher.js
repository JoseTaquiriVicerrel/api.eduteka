
import stringSimilarity from 'string-similarity';
import { normalizeText } from './text_utils.js';

export const matchAndReorderOptions = (oldOptions, newOptions) => {
    const oldKeys = Object.keys(oldOptions).sort();
    const newKeys = Object.keys(newOptions).sort();

    const mappedOptions = {};
    let needsManualReview = false;

    // Remove HTML tags for comparison
    const stripHtml = (text) => text.toString().replace(/<[^>]+>/g, '').trim();

    const oldValues = oldKeys.map(k => ({ key: k, text: normalizeText(stripHtml(oldOptions[k])) }));
    const newValues = newKeys.map(k => ({ key: k, text: normalizeText(stripHtml(newOptions[k])) }));

    oldKeys.forEach(oldKey => {
        const oldText = oldValues.find(v => v.key === oldKey).text;

        // Find best match in newOptions
        let bestMatch = { key: null, similarity: 0 };

        newValues.forEach(newV => {
            const similarity = stringSimilarity.compareTwoStrings(oldText, newV.text);
            if (similarity > bestMatch.similarity) {
                bestMatch = { key: newV.key, similarity };
            }
        });

        // Threshold for clear match
        if (bestMatch.similarity > 0.7) {
            mappedOptions[oldKey] = newOptions[bestMatch.key];
        } else {
            // Fallback: Assign in order or flag
            needsManualReview = true;
            mappedOptions[oldKey] = newOptions[oldKey] || newOptions[newKeys[0]];
        }
        console.log(mappedOptions[oldKey]);
    });

    return { options: mappedOptions, needsManualReview };
};
