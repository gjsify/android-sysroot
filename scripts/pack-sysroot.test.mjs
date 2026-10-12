// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
