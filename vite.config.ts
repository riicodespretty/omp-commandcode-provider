import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		printWidth: 100,
		semi: true,
		ignorePatterns: ["styles/**", "tools/**", "bun.lock"],
	},
	lint: {
		ignorePatterns: ["tools/oxlint/anti-slop/**", "styles/**"],
		jsPlugins: [
			{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
			{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
		],
		plugins: [
			"eslint",
			"typescript",
			"unicorn",
			"oxc",
			"import",
			"jsdoc",
			"jsx-a11y",
			"node",
			"promise",
			"vitest",
		],
		rules: {
			"anti-slop/no-chained-type-assertions": "error",
			"anti-slop/no-conditional-empty-object-spread": "error",
			"anti-slop/no-known-value-widening": "error",
			"anti-slop/no-module-mocking": "error",
			"anti-slop/no-object-parameters": "error",
			"anti-slop/no-reflect-apply": "error",
			"anti-slop/no-reflect-get": "error",
			"anti-slop/no-runtime-typeof": "error",
			"anti-slop/no-shape-in-symbol-names": "error",
			"anti-slop/no-unknown-parameters": "error",
			"anti-slop/no-unknown-returns": "error",
			"anti-slop/no-unknown-type-aliases": "error",
			"anti-slop/no-widen-then-assert": "error",
			"anti-slop/require-safety-comment-for-type-assertion": "error",
			"vite-plus/prefer-vite-plus-imports": "error",
		},
		options: { denyWarnings: true, typeCheck: true, typeAware: true },
		categories: { correctness: "warn" },
	},
});
