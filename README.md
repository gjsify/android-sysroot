# android-sysroot

A prebuilt, pinned GLib / GObject-Introspection prefix for Android, one tarball per ABI
(`arm64-v8a`, `x86_64`). It is the build input of
[`@gjsify/gi-runtime-android`](https://github.com/gjsify/gjsify/tree/main/packages/node-gi/gi-runtime-android):
gjsify's release job downloads it, checks it against the sha256 sums pinned in gjsify, and
cross-builds `@gjsify/node-gi` and the AAR from it with nothing but the Android NDK.

The same split as NativeScript's V8 ([`NativeScript/v8-buildscripts`](https://github.com/NativeScript/v8-buildscripts)
releases, pinned by `V8_RELEASE` in `NativeScript/android`), and the role gvsbuild's release
assets play for gjsify's Windows bundle: the expensive part is built rarely, here; the
cheap part on every release, there.

## How it is built

g-ir-scanner has to *run* a dumper binary compiled for the target, which is why this used
to be a hand build on a machine with an Android device attached. It no longer needs one:
`tools/qemu-run` runs that binary under qemu-user against a bionic runtime unpacked from
the official Android system image, so a plain GitHub runner can do it — byte-identical to
the hand build for both ABIs, 21 typelibs and 34 shared objects each, arm64-v8a included
from an x86_64 runner. See [docs/ci-build.md](docs/ci-build.md).

The `build` workflow builds one ABI and uploads the tarball as a **workflow artifact**;
releases are still cut by hand, deliberately. Give it a release tag in `compare-release`
and it checks its result against that release, file by file.

## What a release holds

`android-sysroot-<tag>-<abi>.tar.gz` and `SHA256SUMS`. The tarballs are byte-reproducible
from the same build tree (fixed order, owner and mtime; gzip without name or timestamp), and
each ABI's lands in its own directories, so all of them unpack into one prefix:

```
include/<abi>/                 headers (three of them differ between ABIs)
lib/<abi>/*.so                 the stack, --strip-debug
lib/<abi>/pkgconfig/*.pc       relocatable: prefix=${pcfiledir}/../../..
lib/<abi>/girepository-1.0/    typelibs
lib/<abi>/glib-2.0/include/    glibconfig.h, and the other per-arch config headers
share/licenses/<project>/      licence texts from every subproject's source tree
share/android-sysroot/<abi>.json
                               NDK revision, libraries, typelibs, the directories it was
                               built in, and the exact git commit or version of every
                               subproject
```

## Building it

Host: Linux with meson, glib, gobject-introspection and `gtk4-devel`/`pango-devel`
installed (the host's `g-ir-compiler` and GIRs are used), qemu-user for the target
architecture, `erofs-utils` and `e2fsprogs`, the Android SDK and NDK 27.1.12297006, and
pixiewood from [gtk-android-builder](https://github.com/sp1ritCS/gtk-android-builder).

```sh
pip install --target tools/pyvendor patchelf

# the bionic runtime the dumper runs against, from an SDK system image
tools/make-android-root --abi x86_64 --image <system.img> --out ~/.cache/android-root

export ANDROID_SDK_ROOT=~/Android/Sdk
export ANDROID_NDK_ROOT=$ANDROID_SDK_ROOT/ndk/27.1.12297006
export ANDROID_SYSTEM_ROOT=~/.cache/android-root
export PIXIEWOOD=<gtk-android-builder>/pixiewood

scripts/ci-build --abi x86_64 --tag <tag> --out dist
gh release create <tag> dist/*.tar.gz dist/SHA256SUMS
```

`ci-build` prepares the recipe, builds it and packs the tarball; run it once per ABI into
the same `dist`. `recipe/` is a minimal pixiewood app (`gi-probe`) whose only purpose is to
make pixiewood build the GTK/Libadwaita stack with introspection on; `pack-sysroot.mjs`
leaves its own library out. `tools/` holds the cross-build glue — `qemu-run` (meson's
`exe_wrapper` and g-ir-scanner's `GI_CROSS_LAUNCHER`), `adb-run` for the same job on a real
device, and the `g-ir-scanner` and `pkg-config` wrappers — and is explained in gjsify's
[report on GI in a pixiewood APK](https://github.com/gjsify/gjsify/blob/main/docs/reports/2026-10-10-gi-in-a-pixiewood-apk.md).

The wraps track upstream branches, so two builds a week apart differ. What a given tarball
was built from is in its `share/android-sysroot/<abi>.json`, and `ci-build --pin <that
file>` builds from the same commits again — see [docs/ci-build.md](docs/ci-build.md) for
what else has to match for the result to be byte-identical.

## Tests

```sh
node --test 'scripts/*.test.mjs'
```

## License

The recipe and scripts are MIT ([LICENSE](LICENSE)). The binaries in the release assets
keep their own projects' terms; each tarball carries the texts under `share/licenses/`.
