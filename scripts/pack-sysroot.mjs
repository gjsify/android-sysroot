#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pack a pixiewood build of the GLib/GObject-Introspection stack into one relocatable
// prefix tarball per Android ABI, plus SHA256SUMS. The tarballs are the release assets of
// this repository; @gjsify/gi-runtime-android's release job downloads one per ABI and
// checks it against the sums pinned in gjsify.
//
// WHY `meson install` AND NOT pixiewood's `root/`. pixiewood installs `--tags runtime`
// only, so its root has the libraries but no headers and no .pc files — and building
// @gjsify/node-gi needs both. Installing the whole build tree into a scratch destdir
// gives the complete prefix; this script then keeps what a consumer links against.
//
// WHY EVERY ABI GETS ITS OWN include/. Three installed headers differ between arm64-v8a
// and x86_64 (ffi.h, ffitarget.h, jconfig.h), so a shared include/ would be wrong for
// one of them. The layout is `include/<abi>/` beside `lib/<abi>/`, so both tarballs
// unpack into the same directory without overwriting each other.
//
// WHY THE .pc FILES ARE REWRITTEN. meson writes `prefix=/` (pixiewood configures the
// prefix as `/`) and links zlib by the NDK's absolute path. The rewrite makes `prefix`
// relative to the .pc file (`${pcfiledir}`, which pkg-config and pkgconf both expand),
// points `includedir` at `include/<abi>`, turns the NDK libz path into `-lz` and drops
// `-I` of the NDK sysroot's own include dir, which clang searches anyway. A
// .pc that still names an absolute path afterwards fails the pack, by file and line.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** ABI -> pixiewood's build directory suffix. */
const ABIS = {
    'arm64-v8a': 'aarch64',
    x86_64: 'x86_64',
};

/**
 * Under lib/<abi>/, dropped: build-system metadata nobody links against from here. Static
 * archives (`*.a`, pcre2's) go too: everything that needs them already linked them in.
 */
const LIB_DROP = new Set(['cmake']);

/** Licence files copied from every subproject's top level into share/licenses/<project>/. */
const LICENCE_FILE = /^(COPYING|LICEN[CS]E|Copyright|COPYRIGHT)([._-].*)?$/i;

/** Licence files below the top level, by project. Only what top-level matching misses. */
const LICENCE_EXTRA = {
    freetype: ['docs/FTL.TXT', 'docs/GPLv2.TXT'],
};

function usage(code) {
    process.stdout.write(`usage: pack-sysroot.mjs --source <dir> --tag <tag> --out <dir> [--abi <abi>]... [--ndk <dir>]

Pack the pixiewood build in <source>/.pixiewood into android-sysroot-<tag>-<abi>.tar.gz.

  --source <dir>   the pixiewood project (holds .pixiewood/ and subprojects/)
  --tag <tag>      release tag, part of every asset name
  --out <dir>      where the tarballs and SHA256SUMS go
  --abi <abi>      repeatable; default: ${Object.keys(ABIS).join(', ')}
  --ndk <dir>      Android NDK root, for llvm-strip                        [ANDROID_NDK_HOME]
`);
    process.exit(code);
}

function fail(message) {
    process.stderr.write(`pack-sysroot: ${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { abis: [], ndk: process.env.ANDROID_NDK_HOME };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') usage(0);
        const value = argv[++i];
        if (value === undefined) fail(`${flag} needs a value`);
        if (flag === '--source') opts.source = resolve(value);
        else if (flag === '--tag') opts.tag = value;
        else if (flag === '--out') opts.out = resolve(value);
        else if (flag === '--abi') opts.abis.push(value);
        else if (flag === '--ndk') opts.ndk = resolve(value);
        else fail(`unknown flag ${flag}`);
    }
    if (!opts.source || !opts.tag || !opts.out) usage(2);
    if (!opts.ndk) fail('--ndk or ANDROID_NDK_HOME is required');
    if (opts.abis.length === 0) opts.abis = Object.keys(ABIS);
    for (const abi of opts.abis) if (!(abi in ABIS)) fail(`unknown ABI ${abi}`);
    if (!/^[\w.-]+$/.test(opts.tag)) fail(`--tag ${opts.tag} is not a plain name`);
    return opts;
}

function run(cmd, args, options = {}) {
    return execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 256 * 1024 * 1024,
        ...options,
    });
}

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(path));
        else out.push(path);
    }
    return out;
}

/** Install files of the build's own top-level project — the probe app, not the stack. */
function ownTargets(buildDir) {
    const targets = JSON.parse(run('meson', ['introspect', '--targets', buildDir]));
    return new Set(
        targets
            .filter((t) => t.subproject === null && t.installed)
            .flatMap((t) => t.install_filename.map((f) => basename(f))),
    );
}

export function rewritePc(text, abi) {
    return text
        .split('\n')
        .map((line) => {
            if (/^prefix=\/$/.test(line)) return 'prefix=${pcfiledir}/../../..';
            if (/^exec_prefix=\/$/.test(line)) return 'exec_prefix=${prefix}';
            return line
                .replace(/\$\{prefix\}\/include(?=\/|\s|$)/g, `\${prefix}/include/${abi}`)
                .replace(/\S*\/sysroot\/usr\/lib\/[\w-]+-linux-android\/\d+\/lib(\w+)\.so\b/g, '-l$1')
                .replace(/\s+-I\S*\/sysroot\/usr\/include(?=\s|$)/g, '');
        })
        .join('\n');
}

/** Absolute paths left in what a compiler or linker sees, as `file:line`. */
export function absolutePaths(name, text) {
    const problems = [];
    text.split('\n').forEach((line, i) => {
        if (!/^(Cflags|Libs)(\.private)?:/.test(line)) return;
        if (/(^|\s)(-[IL])?\//.test(line.replace(/^[\w.]+:/, ''))) problems.push(`${name}:${i + 1}: ${line}`);
    });
    return problems;
}

function copyLicences(subprojects, dest) {
    const found = [];
    for (const entry of readdirSync(subprojects, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'packagecache' || entry.name === 'packagefiles') continue;
        const project = entry.name.replace(/-\d[\w.]*$/, '');
        const src = join(subprojects, entry.name);
        const files = readdirSync(src).filter((f) => LICENCE_FILE.test(f) && statSync(join(src, f)).isFile());
        for (const extra of LICENCE_EXTRA[project] ?? []) if (existsSync(join(src, extra))) files.push(extra);
        // copyFileSync, not cpSync: glib's COPYING is a symlink into LICENSES/, and
        // cpSync refuses it even with dereference (it stats the link, not the target).
        for (const file of files) {
            mkdirSync(dirname(join(dest, project, file)), { recursive: true });
            copyFileSync(join(src, file), join(dest, project, file));
        }
        if (files.length > 0) found.push(project);
    }
    return found.sort();
}

/** Each subproject's exact revision: the git commit when it is a checkout, else its directory's version suffix. */
function sourceRevisions(subprojects) {
    const out = {};
    for (const entry of readdirSync(subprojects, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isDirectory() || entry.name === 'packagecache' || entry.name === 'packagefiles') continue;
        const dir = join(subprojects, entry.name);
        if (existsSync(join(dir, '.git'))) {
            out[entry.name] = { git: run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim() };
        } else {
            const version = /-(\d[\w.]*)$/.exec(entry.name)?.[1];
            out[entry.name] = version ? { version } : { unpinned: true };
        }
    }
    return out;
}

function ndkRevision(ndk) {
    const props = readFileSync(join(ndk, 'source.properties'), 'utf8');
    return /Pkg\.Revision\s*=\s*(\S+)/.exec(props)?.[1] ?? 'unknown';
}

function packAbi({ abi, source, ndk, tag, out, scratch }) {
    const pixiewood = join(source, '.pixiewood');
    const buildDir = join(pixiewood, `bin-${ABIS[abi]}`);
    if (!existsSync(buildDir)) fail(`${buildDir} does not exist: nothing built for ${abi}`);

    const destdir = join(scratch, `install-${abi}`);
    run('meson', ['install', '-C', buildDir, '--no-rebuild', '--quiet', '--destdir', destdir]);
    const installedLib = join(destdir, 'lib', abi);
    if (!existsSync(installedLib)) fail(`meson install wrote no lib/${abi} — is libdir lib/${abi}?`);

    const stage = join(scratch, `stage-${abi}`);
    cpSync(join(destdir, 'include'), join(stage, 'include', abi), { recursive: true });

    const own = ownTargets(buildDir);
    const libs = [];
    for (const entry of readdirSync(installedLib)) {
        if (LIB_DROP.has(entry) || own.has(entry) || entry.endsWith('.a')) continue;
        cpSync(join(installedLib, entry), join(stage, 'lib', abi, entry), { recursive: true });
        if (entry.endsWith('.so')) libs.push(entry);
    }
    if (libs.length === 0) fail(`no libraries under lib/${abi}`);

    const strip = join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin', 'llvm-strip');
    run(strip, ['--strip-debug', ...libs.map((lib) => join(stage, 'lib', abi, lib))]);

    const pcDir = join(stage, 'lib', abi, 'pkgconfig');
    const problems = [];
    for (const name of readdirSync(pcDir).filter((f) => f.endsWith('.pc'))) {
        const text = rewritePc(readFileSync(join(pcDir, name), 'utf8'), abi);
        problems.push(...absolutePaths(name, text));
        writeFileSync(join(pcDir, name), text);
    }
    if (problems.length > 0) fail(`absolute paths left in .pc files:\n  ${problems.join('\n  ')}`);

    const subprojects = join(source, 'subprojects');
    const licensed = copyLicences(subprojects, join(stage, 'share', 'licenses'));

    const manifest = {
        abi,
        tag,
        // meson sizes the rpath placeholder it links into every library from
        // the build-time rpath, which names both of these directories, so a
        // rebuild is only byte-identical when their paths are the same length.
        buildRoot: resolve(source),
        ndkRoot: resolve(ndk),
        ndk: ndkRevision(ndk),
        libraries: libs.sort(),
        typelibs: readdirSync(join(stage, 'lib', abi, 'girepository-1.0')).sort(),
        licensedProjects: licensed,
        sources: sourceRevisions(subprojects),
    };
    mkdirSync(join(stage, 'share', 'android-sysroot'), { recursive: true });
    writeFileSync(join(stage, 'share', 'android-sysroot', `${abi}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

    // Byte-reproducible: fixed order, owner and mtime, and gzip without a name or timestamp.
    const asset = `android-sysroot-${tag}-${abi}.tar.gz`;
    run('sh', [
        '-c',
        'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$1" include lib share | gzip -9n > "$2"',
        'sh',
        stage,
        join(out, asset),
    ]);
    const files = walk(stage).length;
    return { asset, files };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    mkdirSync(opts.out, { recursive: true });
    const scratch = mkdtempSync(join(tmpdir(), 'android-sysroot-'));
    try {
        const sums = [];
        for (const abi of opts.abis) {
            const { asset, files } = packAbi({ abi, ...opts, scratch });
            const sha = createHash('sha256').update(readFileSync(join(opts.out, asset))).digest('hex');
            sums.push(`${sha}  ${asset}`);
            process.stdout.write(`${asset}  ${files} files  ${sha}\n`);
        }
        writeFileSync(join(opts.out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
        process.stdout.write(`${relative(process.cwd(), join(opts.out, 'SHA256SUMS'))}\n`);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
