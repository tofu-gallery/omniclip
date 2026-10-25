#!/usr/bin/env node
// Tofu gallery build for Omniclip: writes site/, the finished site a Tofu copy serves (preset static, root folder site).
//
// 1. Upstream's own compile: tsc (tsconfig.json, s/ -> x/), then @benev/turtle renders x/index.html and copies the
//    stylesheets, as `turtle-standard` does. importly and rollup are not run: their importmap pointed the page at a
//    copied node_modules tree, which a Tofu import leaves out.
// 2. esbuild bundles the compiled x/main.js and the four module workers into five files, with every npm package inside.
//    Upstream's CDN scripts and `https://` imports stay where upstream loads them from.
// 3. site/ gets index.html (upstream's, served without es-module-shims and its importmap), the stylesheets, the bundles,
//    coi-serviceworker.js, only the files under assets/ that those reference, and the licence files.
//
//   npm ci && node scripts/tofu-build.mjs
import {execFileSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as esbuild from 'esbuild'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const x = join(root, 'x')
const site = join(root, 'site')
const bin = (name) => join(root, 'node_modules', '.bin', name)
const run = (command, args) => execFileSync(command, args, {cwd: root, stdio: 'inherit'})
const fail = (message) => { console.error(`tofu-build: ${message}`); process.exit(1) }
const copy = (from, to) => { mkdirSync(dirname(to), {recursive: true}); copyFileSync(from, to) }

// 1. Upstream's compile.
rmSync(x, {recursive: true, force: true})
run(bin('tsc'), [])
run(bin('turtle'), ['--in=s:x', '--out=x', '--exclude=**/*.partial.html.js:**/*.map'])

// 2. The bundles. Each `new Worker(new URL("<file>", import.meta.url))` is pointed at that worker's bundle,
//    which sits beside every other bundle at the site's root.
const entries = {
	'main': join(x, 'main.js'),
	'encode_worker': join(x, 'context/controllers/video-export/parts/encode_worker.js'),
	'decode_worker': join(x, 'context/controllers/video-export/parts/decode_worker.js'),
	'opfs-worker': join(x, 'context/controllers/collaboration/parts/opfs-worker.js'),
	'ffmpeg-worker': join(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js'),
}
const bundleOf = new Map(Object.entries(entries).map(([name, path]) => [realpathSync(path), `./${name}.js`]))
const workerUrls = {
	name: 'tofu-worker-urls',
	setup(build) {
		// Upstream's importmap mapped each package to its folder, so the code imports files such as
		// "@zip.js/zip.js/index.js" that a package's `exports` hides. Those resolve to that file, as they did there.
		build.onResolve({filter: /^(?:@[^/.:][^/:]*\/)?[^/.@:][^/:]*\/.+/}, async (args) => {
			if (args.pluginData === 'tofu-direct') return undefined
			const normal = await build.resolve(args.path, {kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: 'tofu-direct'})
			if (!normal.errors.length) return normal
			const file = join(root, 'node_modules', args.path)
			return existsSync(file) && statSync(file).isFile() ? {path: realpathSync(file)} : undefined
		})
		build.onLoad({filter: /\.m?js$/}, (args) => {
			const source = readFileSync(args.path, 'utf8')
			if (!source.includes('import.meta.url')) return undefined
			const contents = source.replace(/new Worker\(\s*new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g, (match, _quote, file) => {
				if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return match
				const bundle = bundleOf.get(resolve(dirname(args.path), file))
				if (!bundle) fail(`${relative(root, args.path)} loads ${file}, which no bundle provides`)
				return `new Worker(new URL(${JSON.stringify(bundle)}, import.meta.url)`
			})
			return {contents, loader: 'js'}
		})
	},
}
rmSync(site, {recursive: true, force: true})
const built = await esbuild.build({
	absWorkingDir: root,
	entryPoints: entries,
	outdir: site,
	bundle: true,
	format: 'esm',
	splitting: false,
	minify: true,
	keepNames: true,
	legalComments: 'eof',
	charset: 'utf8',
	external: ['https://*'],
	plugins: [workerUrls],
	metafile: true,
	logLevel: 'warning',
})

for (const name of Object.keys(entries)) {
	const code = readFileSync(join(site, `${name}.js`), 'utf8')
	const left = [...code.matchAll(/.{0,60}import\.meta\.url.{0,20}/g)].map((m) => m[0]).filter((s) => !/URL\("\.\/[a-z_-]+\.js",import\.meta\.url\)/.test(s))
	if (left.length) console.log(`tofu-build: ${name}.js keeps import.meta.url in: ${left.join(' | ')}`)
}

// 3a. index.html: upstream's page, with main.js loaded as the plain module it now is.
let page = readFileSync(join(x, 'index.html'), 'utf8')
for (const [from, to] of [
	['\t\t<script type="importmap-shim" src="./importmap.json"></script>\n', ''],
	['\t\t<script defer src="https://cdn.jsdelivr.net/npm/es-module-shims@1.8.2/dist/es-module-shims.min.js"></script>\n', ''],
	['<script type="module-shim" src="./main.js"></script>', '<script type="module" src="./main.js"></script>'],
]) {
	if (!page.includes(from)) fail(`index.html no longer contains ${JSON.stringify(from.trim())}`)
	page = page.replace(from, to)
}
writeFileSync(join(site, 'index.html'), page)
copy(join(root, 'node_modules/coi-serviceworker/coi-serviceworker.js'), join(site, 'coi-serviceworker.js'))

// 3b. Every file the site refers to: the stylesheets and what they import, and each assets/ file named in a bundle or
//     the page. A site path under assets/ comes from the repository's assets/; any other from upstream's compile (x/).
const sourceOf = (path) => (path.startsWith('assets/') ? join(root, path) : join(x, path))
const queue = ['index.css']
// A name whose first folder is not one of upstream's assets/ entries belongs to something else (a link inside
// gl-transitions' shader comments names a GitHub assets/ folder, for one): those are listed, not copied.
const assetEntries = new Set(readdirSync(join(root, 'assets')))
const foreign = new Set()
const named = (text) => [...text.matchAll(/(?<![A-Za-z0-9_])\/?(assets\/[A-Za-z0-9_\-./]*[A-Za-z0-9_-]\.[A-Za-z0-9]+)/g)]
	.map((m) => m[1]).filter((path) => assetEntries.has(path.split('/')[1]) || (foreign.add(path), false))
for (const file of ['index.html', ...Object.keys(entries).map((name) => `${name}.js`)]) queue.push(...named(readFileSync(join(site, file), 'utf8')))
const copied = new Set()
// Upstream's page links this favicon, which upstream never shipped (a 404 on omniclip.app too); it is left as it is.
const upstreamMissing = new Set(['assets/favicon-32x32.png'])
while (queue.length) {
	const path = new URL(queue.shift(), 'http://site/').pathname.slice(1)
	if (copied.has(path) || upstreamMissing.has(path)) continue
	const from = sourceOf(path)
	if (!existsSync(from)) fail(`the site refers to ${path}, which does not exist`)
	copy(from, join(site, path))
	copied.add(path)
	if (path.endsWith('.css')) {
		for (const m of readFileSync(from, 'utf8').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
			const ref = m[2].split(/[?#]/)[0]
			if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue
			queue.push(new URL(ref, `http://site/${path}`).pathname.slice(1))
		}
	}
}

// 3c. Licences: Omniclip's, the fonts' (beside the fonts), and a list of the code inside the bundles and of the other
//     third-party files the site serves. They are written as .txt: Tofu's static hosting leaves out repository text
//     such as LICENSE or license.md.
copy(join(root, 'LICENSE'), join(site, 'LICENSE.txt'))
copy(join(root, 'assets/fonts/Poppins/License/OFL.txt'), join(site, 'assets/fonts/Poppins/License/OFL.txt'))
copy(join(root, 'assets/fonts/NotoEmoji/license.md'), join(site, 'assets/fonts/NotoEmoji/license.txt'))
const packages = new Map()
for (const input of Object.keys(built.metafile.inputs)) {
	const m = input.match(/^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)\//)
	if (m) packages.set(join(root, m[1], m[2]), m[2])
}
const licenceFile = (dir) => readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name))
const noticeFile = (dir) => readdirSync(dir).find((name) => /^notice(\.(md|txt))?$/i.test(name))
// Packages whose npm package ships no licence file: the licence of the project they come from, kept in scripts/licenses.
const ffmpegWasm = ['ffmpeg.wasm-LICENSE.txt', 'ffmpeg.wasm\'s LICENSE (https://github.com/ffmpegwasm/ffmpeg.wasm, tag v0.12.9), which covers @ffmpeg/ffmpeg and @ffmpeg/util']
const projectLicence = {
	'@ffmpeg/ffmpeg': ffmpegWasm,
	'@ffmpeg/util': ffmpegWasm,
	'gl-transitions': ['gl-transitions-LICENSE.txt', 'the gl-transitions project\'s LICENSE (https://github.com/gl-transitions/gl-transitions, commit 87ed92e). Each transition also names its author and licence in its shader source inside main.js; the two that are not MIT (InvertedPageCurl, BSD-3-Clause; StereoViewer, BSD-2-Clause) carry their full licence text there'],
}
const sections = [...packages].sort(([a, x], [b, y]) => x.localeCompare(y) || a.localeCompare(b)).map(([dir, name]) => {
	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	const file = licenceFile(dir)
	const notice = noticeFile(dir)
	const licence = file ? readFileSync(join(dir, file), 'utf8').trim()
		: projectLicence[name] ? `(The npm package ships no licence file. This is ${projectLicence[name][1]}:)\n\n${readFileSync(join(root, 'scripts/licenses', projectLicence[name][0]), 'utf8').trim()}`
		: '(The package ships no licence file.)'
	return `${name} ${manifest.version}\nLicence: ${manifest.license ?? '(not stated in package.json)'}\n${manifest.homepage ?? ''}\n\n${licence}${notice ? `\n\n${notice}:\n${readFileSync(join(dir, notice), 'utf8').trim()}` : ''}`
})
// assets/MediaInfoModule.wasm is mediainfo.js's compiled MediaInfoLib (BSD-2-Clause), whose notice travels with it.
const mediainfo = join(root, 'node_modules/mediainfo.js')
if (!readFileSync(join(root, 'assets/MediaInfoModule.wasm')).equals(readFileSync(join(mediainfo, 'dist/MediaInfoModule.wasm')))) {
	fail('assets/MediaInfoModule.wasm is no longer the file mediainfo.js ships: find out whose it is, and its licence')
}
const mediainfoVersion = JSON.parse(readFileSync(join(mediainfo, 'package.json'), 'utf8')).version
const vendored = [
	['Icons: Carbon (s/icons/carbon-icons)', 's/icons/carbon-icons/LICENSE.md'],
	['Icons: Gravity UI (s/icons/gravity-ui)', 's/icons/gravity-ui/LICENSE.md'],
	['Icons: Material Design Icons (s/icons/material-design-icons)', 's/icons/material-design-icons/LICENSE.md'],
	['Icons: Remix Icon (s/icons/remix-icon)', 's/icons/remix-icon/LICENSE.md'],
	['Aligning guidelines (s/context/controllers/compositor/lib)', 's/context/controllers/compositor/lib/license.md'],
	['coi-serviceworker (coi-serviceworker.js)', 'node_modules/coi-serviceworker/LICENSE'],
	[`mediainfo.js ${mediainfoVersion} (assets/MediaInfoModule.wasm, its compiled MediaInfoLib; the JavaScript that loads it comes from jsDelivr)`, 'node_modules/mediainfo.js/LICENSE.txt'],
].map(([label, file]) => `${label}\n\n${readFileSync(join(root, file), 'utf8').trim()}`)
mkdirSync(join(site, 'licenses'), {recursive: true})
writeFileSync(join(site, 'licenses/THIRD-PARTY-LICENSES.txt'), [
	'Omniclip, as built for Tofu\'s gallery by scripts/tofu-build.mjs. Omniclip itself is MIT-licensed (../LICENSE.txt).',
	'The bundles (main.js and the four *worker.js files) contain the npm packages below, then code upstream keeps in its own source (the icon sets and the aligning guidelines). coi-serviceworker.js and assets/MediaInfoModule.wasm are listed last. Each font\'s licence sits beside it under assets/fonts.',
	'Scripts, styles and fonts the page loads from CDNs (jsDelivr, unpkg, Google Fonts) are not part of this site; TOFU.md in the source lists them.',
	...sections, ...vendored,
].join(`\n\n${'='.repeat(78)}\n\n`) + '\n')
writeFileSync(join(site, 'README.txt'), [
	'This folder is the finished Omniclip web app, built by scripts/tofu-build.mjs in https://github.com/tofu-gallery/omniclip',
	'(branch tofu). Serve it as a static site at the root of its address. TOFU.md in that repository explains the build.',
	'',
].join('\n'))

// 4. Checks: nothing of PostHog, nothing of the Nippo font (its Fontshare EULA forbids passing it on or serving it),
//    no source maps or host configuration, within the Free static lane's limits.
const files = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); statSync(path).isDirectory() ? walk(path) : files.push(path) } }
walk(site)
for (const file of files) {
	if (/\.(map|ts)$|(^|\/)_(headers|redirects)$/.test(file)) fail(`${relative(root, file)} must not be published`)
	if (/nippo/i.test(relative(site, file))) fail(`${relative(root, file)} is the Nippo font, which its EULA does not let a copy serve`)
	if (/\.(js|html|css)$/.test(file) && /posthog|phc_[A-Za-z0-9]{20}/i.test(readFileSync(file, 'utf8'))) fail(`${relative(root, file)} mentions PostHog`)
	if (/\.(js|html|css)$/.test(file) && /nippo/i.test(readFileSync(file, 'utf8'))) fail(`${relative(root, file)} still asks for the Nippo font`)
}
const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
if (files.length >= 500) fail(`${files.length} files: over the Free static lane's 500`)
if (foreign.size) console.log(`tofu-build: assets/ names that are no file of upstream's, left alone: ${[...foreign].join(', ')}`)
console.log(`tofu-build: site/ is ready (${files.length} files, ${(bytes / 1e6).toFixed(2)} MB, ${packages.size} npm packages bundled, ${copied.size} referenced files copied)`)
