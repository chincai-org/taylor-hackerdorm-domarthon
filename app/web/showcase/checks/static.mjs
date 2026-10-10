// Development-only validators; no package or script is needed by the delivered pages.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
	join(
		process.env.QUALITY_TOOLS_PATH ??
			join(homedir(), ".workbuddy-ai/binaries/node/workspace"),
		"package.json",
	),
);
const prettier = require("prettier");
const { ESLint } = require("eslint");
const javascript = require("@eslint/js");
const globals = require("globals");
const { HtmlValidate } = require("html-validate");
const stylelint = require("stylelint");
const fixFormatting = process.argv.includes("--format");
const sourceFiles = [];
for (const directory of ["", "lib", "templates", "checks", "data"]) {
	for (const entry of await readdir(join(root, directory), {
		withFileTypes: true,
	})) {
		if (entry.isFile() && /\.(m?js)$/.test(entry.name)) {
			sourceFiles.push(join(root, directory, entry.name));
		}
	}
}
sourceFiles.push(join(root, "styles.css"), join(root, "production.css"));

for (const file of sourceFiles) {
	const original = await readFile(file, "utf8");
	const options = { filepath: file, printWidth: 100 };
	if (fixFormatting) {
		const formatted = await prettier.format(original, options);
		if (formatted !== original) await writeFile(file, formatted, "utf8");
	} else {
		assert.ok(
			await prettier.check(original, options),
			`Run checks/static.mjs --format: ${file}`,
		);
	}
}
console.log(`Formatting: ${sourceFiles.length} authored files passed`);

const eslint = new ESLint({
	cwd: root,
	overrideConfigFile: true,
	overrideConfig: [
		{
			files: ["**/*.mjs", "*.js"],
			languageOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				globals: { ...globals.node, ...globals.browser },
			},
			rules: {
				...javascript.configs.recommended.rules,
				"no-var": "error",
				"prefer-const": "error",
				eqeqeq: "error",
			},
		},
	],
});
const javascriptResults = await eslint.lintFiles(
	sourceFiles.filter((file) => /\.m?js$/.test(file)),
);
const javascriptProblems = javascriptResults.filter(
	(result) => result.errorCount || result.warningCount,
);
assert.equal(
	javascriptProblems.length,
	0,
	await (await eslint.loadFormatter("stylish")).format(javascriptProblems),
);
console.log(`JavaScript lint: ${javascriptResults.length} files passed`);

const stylesheetFiles = (await readdir(root)).filter((name) =>
	name.endsWith(".css"),
);
for (const name of stylesheetFiles) {
	const result = await stylelint.lint({
		code: await readFile(join(root, name), "utf8"),
		codeFilename: join(root, name),
		config: {
			rules: {
				"block-no-empty": true,
				"color-no-invalid-hex": true,
				"declaration-block-no-duplicate-properties": true,
				"declaration-block-no-shorthand-property-overrides": true,
				"property-no-unknown": true,
				"selector-pseudo-class-no-unknown": true,
				"selector-pseudo-element-no-unknown": true,
				"unit-no-unknown": true,
			},
		},
	});
	assert.equal(
		result.errored,
		false,
		`${name}: ${JSON.stringify(result.results.map(({ source, warnings, parseErrors, invalidOptionWarnings }) => ({ source, warnings, parseErrors, invalidOptionWarnings })))}`,
	);
	assert.ok(
		result.results.every((entry) => entry.warnings.length === 0),
		`${name}: CSS warnings`,
	);
}
console.log(`CSS lint: ${stylesheetFiles.length} stylesheets passed`);

const html = new HtmlValidate({
	extends: ["html-validate:recommended"],
	rules: {
		"input-missing-label": "error",
		// SVG bounds are computed at build time, not presentation chosen in the browser.
		"no-inline-style": "off",
		// Diffs and digest preformatted text must retain their original whitespace.
		"no-trailing-whitespace": "off",
		// Both explicit and wrapping labels improve compatibility for the fork select.
		"no-redundant-for": "off",
		// Native lists may have an accessible name; generic divs still may not.
		"aria-label-misuse": ["error", { allowAnyNamable: true }],
	},
});
const pages = (await readdir(root)).filter((name) => name.endsWith(".html"));
for (const name of pages) {
	const report = await html.validateFile(join(root, name));
	assert.ok(
		report.valid,
		`${name}: ${JSON.stringify(report.results.flatMap((result) => result.messages))}`,
	);
}
console.log(`HTML validation: ${pages.length} complete pages passed`);
