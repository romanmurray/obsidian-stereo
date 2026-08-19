import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	// Visualizer base illustrations are inlined into the bundle: the community
	// installer only delivers main.js/manifest.json/styles.css, so loose asset
	// files never reach store installs.
	loader: { ".svg": "text" },
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
