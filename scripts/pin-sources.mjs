#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pin the recipe's dependencies to the exact commits a released prefix was built
// from, so a rebuild can be checked against it.
//
// The wraps track upstream branches (`revision = main`), which is what makes two
// builds a week apart differ. pixiewood takes a `revision` attribute per declared
// dependency, and every other subproject is a `wrap-redirect` into one of those
// trees — so pinning the four the recipe declares pins the whole source set.
//
// Two sources are not reachable that way: pango and freetype2 are pulled in by
// nested wraps that say `revision = main` / `master`. They are fixed after
// `pixiewood prepare` has cloned them (see pinCheckouts), by checking out the
// manifest's commit in the realized tree.
//
// The commits come from a release's own manifest, `share/android-sysroot/<abi>.json`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Realized checkouts of the sources whose nested wraps track a branch, by directory name. */
export const FLOATING = ['pango', 'freetype'];

/**
 * Check out, in each floating source under `subprojects`, the commit the manifest's
 * `sources` records. Meson clones a wrap once and never revisits its `revision`, so
 * this has to happen on the realized tree, between `pixiewood prepare` and `build`.
 * A bare sha is fetchable with depth 1, as it is for pixiewood's own pinning.
 */
export function pinCheckouts(subprojects, sources, names = FLOATING) {
    const done = [];
    for (const name of names) {
        const commit = sources[name]?.git;
        if (!commit) throw new Error(`the manifest records no git commit for ${name}`);
        const dir = join(subprojects, name);
        if (!existsSync(join(dir, '.git'))) throw new Error(`${dir} is not a git checkout`);
        const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
        git('fetch', '-q', '--depth', '1', 'origin', commit);
        git('checkout', '-q', '--detach', commit);
        const head = git('rev-parse', 'HEAD').toString().trim();
        if (head !== commit) throw new Error(`${name} is at ${head}, not ${commit}`);
        done.push(`${name}@${commit.slice(0, 10)}`);
    }
    return done;
}

function usage(code) {
    console.log(`Usage: pin-sources.mjs --xml <pixiewood.xml> --manifest <abi.json>

Rewrites <xml> in place: every declared dependency the manifest knows a git commit
for gets revision="<commit>".

       pin-sources.mjs --checkouts <subprojects dir> --manifest <abi.json>

Checks out the manifest's commit in the realized checkouts of the sources no
revision attribute reaches (${FLOATING.join(', ')}). Fails if one is missing.`);
    process.exit(code);
}

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
    // imported by a test
} else {
    const opts = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        const flag = process.argv[i];
        if (flag === '--help' || flag === '-h') usage(0);
        const value = process.argv[i + 1];
        if (value === undefined) usage(2);
        if (flag === '--xml') opts.xml = value;
        else if (flag === '--manifest') opts.manifest = value;
        else if (flag === '--checkouts') opts.checkouts = value;
        else usage(2);
    }
    if (!opts.manifest || !opts.xml === !opts.checkouts) usage(2);

    const sources = JSON.parse(readFileSync(opts.manifest, 'utf8')).sources ?? {};

    if (opts.checkouts) {
        try {
            console.log(`checked out: ${pinCheckouts(opts.checkouts, sources).join(' ')}`);
        } catch (error) {
            console.error(`pin-sources: ${error.message}`);
            process.exit(1);
        }
        process.exit(0);
    }
    let xml = readFileSync(opts.xml, 'utf8');

    const dependencies = xml.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
    if (!dependencies) {
        console.error(`pin-sources: no <dependencies> in ${opts.xml}`);
        process.exit(1);
    }

    /** Children of a dependency, not dependencies themselves. */
    const NOT_A_DEPENDENCY = new Set(['patch', '/patch']);

    const pinned = [];
    const unpinned = [];
    const block = dependencies[1].replace(/<([a-zA-Z/][\w-]*)([^>]*)>/g, (match, name, attributes) => {
        if (NOT_A_DEPENDENCY.has(name) || name.startsWith('/')) return match;
        if (attributes.includes('revision=')) return match;
        const commit = sources[name]?.git;
        if (!commit) {
            unpinned.push(name);
            return match;
        }
        pinned.push(`${name}@${commit.slice(0, 10)}`);
        // Both `<dep/>` and `<dep>` with children, hence the trailing slash dance.
        const selfClosing = attributes.endsWith('/');
        const rest = selfClosing ? attributes.slice(0, -1) : attributes;
        return `<${name}${rest} revision="${commit}"${selfClosing ? '/' : ''}>`;
    });

    xml = xml.replace(dependencies[1], block);
    writeFileSync(opts.xml, xml);

    console.log(`pinned: ${pinned.join(' ') || 'nothing'}`);
    if (unpinned.length) console.log(`no commit in the manifest: ${unpinned.join(' ')}`);
}
