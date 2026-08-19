// esbuild bundles .svg imports as text (see esbuild.config.mjs).
declare module "*.svg" {
	const content: string;
	export default content;
}
