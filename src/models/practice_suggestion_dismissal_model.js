import mongoose from 'mongoose';
import practiceSuggestionDismissalSchema from '#Schemas/practice_suggestion_dismissal_schema.js';

const PracticeSuggestionDismissal = mongoose.models.PracticeSuggestionDismissal
    || mongoose.model('PracticeSuggestionDismissal', practiceSuggestionDismissalSchema);

export default PracticeSuggestionDismissal;
