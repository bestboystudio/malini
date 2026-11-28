import baseConfig from '@malini/eslint-plugin-hyper-ui/base-config';

export default [
	...baseConfig,
	{
		files: ['src/**/*.{svelte,ts}'],
		rules: { '@malini/desktop/no-motion-while-hidden': 'error' },
	},
	{
		files: ['src/**/*.{svelte,ts}'],
		ignores: ['src/**/*.test.ts'],
		rules: { '@malini/desktop/no-unprompted-focus': 'error' },
	},
];
