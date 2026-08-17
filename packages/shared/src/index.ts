// PACKAGE RESOLUTION NOTE (Step 04 correction — see this package's own
// package.json "exports" map). Every dev/test/typecheck tool in this
// monorepo (tsx, vitest, vite, tsc's own type resolution) resolves
// `@bunny-command-center/shared` to THIS SOURCE FILE directly (the
// unconditional "import"/"default" export target) — nothing about local
// development changed. Node's native TS type-stripping (used when running a
// COMPILED apps/api under plain `node`) does NOT remap this file's
// `./foo.js`-style relative imports to their real `./foo.ts` siblings the
// way tsx/tsc/vite do, so loading this file directly under plain `node`
// fails with ERR_MODULE_NOT_FOUND.
//
// Production instead resolves through this package's own
// `"bcc-compiled-runtime"` export condition to `./dist/index.js` (this same
// file, tsc-compiled — `npm run build`, this package's own `build` script),
// activated ONLY by `apps/api/package.json`'s `start` script
// (`node --conditions=bcc-compiled-runtime dist/server.js`) and the CI
// compiled-runtime smoke test — never by anything that runs this file
// directly from source. Deliberately NOT named `"production"`: Vite treats
// that exact condition name as a built-in it activates automatically during
// `vite build` (`DEV_PROD_CONDITION` in Vite's own resolver), which broke
// `apps/web`'s build the first time this was tried — it would have started
// resolving `@bunny-command-center/shared` to a `dist/` output that isn't
// guaranteed to exist yet at that point in the workspace build, for a
// consumer (the browser bundle) that never needed it to. A project-
// namespaced condition name avoids colliding with any tool's own
// conventions, now or later.
export * from "./types/index.js";
export * from "./constants/index.js";
export * from "./i18n/index.js";
export * from "./realtime/index.js";
