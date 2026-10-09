import js from '@eslint/js';
import globals from 'globals';

// Lint pensado para cazar errores reales (variables sin definir, claves repetidas, codigo
// inalcanzable), no el estilo. Se ejecuta en CI: `npm run lint`.
export default [
    { ignores: ['node_modules/**', 'storage/**'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            // Los argumentos con prefijo _ y los `catch {}` sin variable son intencionales.
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn',
            'no-control-regex': 'off',
            'no-prototype-builtins': 'warn',
        },
    },
];
