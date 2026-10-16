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
// The commits come from a release's own manifest, `share/android-sysroot/<abi>.json`.

import { readFileSync, writeFileSync } from 'node:fs';

function usage(code) {
    console.log(`Usage: pin-sources.mjs --xml <pixiewood.xml> --manifest <abi.json>

Rewrites <xml> in place: every declared dependency the manifest knows a git commit
for gets revision="<commit>".`);
    process.exit(code);
}

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (flag === '--help' || flag === '-h') usage(0);
    const value = process.argv[i + 1];
    if (value === undefined) usage(2);
    if (flag === '--xml') opts.xml = value;
    else if (flag === '--manifest') opts.manifest = value;
    else usage(2);
}
if (!opts.xml || !opts.manifest) usage(2);

const sources = JSON.parse(readFileSync(opts.manifest, 'utf8')).sources ?? {};
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
