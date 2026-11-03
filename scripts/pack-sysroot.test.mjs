// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { absolutePaths, rewritePc } from './pack-sysroot.mjs';

const NDK_LIBZ =
    '/opt/ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/21/libz.so';

test('prefix becomes relative to the .pc file', () => {
    const out = rewritePc('prefix=/\nexec_prefix=/\nlibdir=${prefix}/lib/arm64-v8a', 'arm64-v8a');
    assert.equal(out, 'prefix=${pcfiledir}/../../..\nexec_prefix=${prefix}\nlibdir=${prefix}/lib/arm64-v8a');
});

test('includedir moves under include/<abi>, subdirectories kept', () => {
    const out = rewritePc('includedir=${prefix}/include\nx=${prefix}/include/libpng16\ny=${prefix}/includes', 'x86_64');
    assert.equal(out, 'includedir=${prefix}/include/x86_64\nx=${prefix}/include/x86_64/libpng16\ny=${prefix}/includes');
});

test('the NDK libz path becomes -lz', () => {
    const out = rewritePc(`Libs.private: -lm ${NDK_LIBZ} -pthread`, 'arm64-v8a');
    assert.equal(out, 'Libs.private: -lm -lz -pthread');
});

test('-I of the NDK sysroot include dir is dropped', () => {
    const out = rewritePc('Cflags: -I${includedir} -I/opt/ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include', 'x86_64');
    assert.equal(out, 'Cflags: -I${includedir}');
});

test('an absolute path left in Cflags or Libs is reported, variables are not', () => {
    const text = 'sysconfdir=/etc\nCflags: -I${includedir}\nLibs: -L/usr/lib -lfoo';
    assert.deepEqual(absolutePaths('foo.pc', text), ['foo.pc:3: Libs: -L/usr/lib -lfoo']);
});

test('host-typelibs compiles included namespaces the build lacks', { skip: !existsSync('/usr/share/gir-1.0/cairo-1.0.gir') }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-typelibs-'));
    try {
        mkdirSync(join(dir, 'build'));
        mkdirSync(join(dir, 'out'));
        writeFileSync(join(dir, 'build', 'X-1.0.gir'), '<repository><include name="cairo" version="1.0"/></repository>');
        for (const ns of ['GLib-2.0', 'GObject-2.0']) writeFileSync(join(dir, 'out', `${ns}.typelib`), '');
        const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'host-typelibs');
        const out = execFileSync(helper, [join(dir, 'build'), join(dir, 'out'), join(dir, 'tmp')], { encoding: 'utf8' });
        assert.equal(out, 'cairo-1.0\n');
        assert.ok(existsSync(join(dir, 'out', 'cairo-1.0.typelib')));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
