// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinCheckouts } from './pin-sources.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** An upstream with two commits, and a depth-1 clone of its tip, as a wrap-git leaves it. */
function floating(root, name) {
    const upstream = join(root, 'upstream', name);
    mkdirSync(upstream, { recursive: true });
    git(upstream, 'init', '-q', '-b', 'main');
    git(upstream, 'config', 'user.email', 't@example.org');
    git(upstream, 'config', 'user.name', 't');
    writeFileSync(join(upstream, 'f'), '1');
    git(upstream, 'add', 'f');
    git(upstream, 'commit', '-qm', 'one');
    const first = git(upstream, 'rev-parse', 'HEAD');
    writeFileSync(join(upstream, 'f'), '2');
    git(upstream, 'commit', '-qam', 'two');
    mkdirSync(join(root, 'subprojects'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${upstream}`, join(root, 'subprojects', name)]);
    return first;
}

test('the realized checkouts move to the commits the manifest records', () => {
    const root = mkdtempSync(join(tmpdir(), 'pin-sources-'));
    const sources = { pango: { git: floating(root, 'pango') }, freetype: { git: floating(root, 'freetype') } };
    const done = pinCheckouts(join(root, 'subprojects'), sources);
    assert.equal(done.length, 2);
    for (const name of ['pango', 'freetype']) {
        assert.equal(git(join(root, 'subprojects', name), 'rev-parse', 'HEAD'), sources[name].git);
    }
});

test('a missing commit or checkout fails loudly', () => {
    const root = mkdtempSync(join(tmpdir(), 'pin-sources-'));
    const first = floating(root, 'pango');
    assert.throws(() => pinCheckouts(join(root, 'subprojects'), { pango: { git: first } }), /no git commit for freetype/);
    assert.throws(() => pinCheckouts(join(root, 'subprojects'), { pango: {}, freetype: { git: first } }), /no git commit for pango/);
    assert.throws(
        () => pinCheckouts(join(root, 'subprojects'), { pango: { git: first }, freetype: { git: first } }),
        /freetype is not a git checkout/,
    );
});
