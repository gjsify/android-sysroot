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

## Why it is not built in CI

g-ir-scanner has to *run* a dumper binary compiled for the target. This build runs it on
an Android emulator over adb (`tools/adb-run`), which a GitHub runner does not offer
cheaply. So the prefix is rebuilt by hand, and only when the stack changes — glib,
gobject-introspection, the NDK, or a patch.

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
                               NDK revision, libraries, typelibs, and the exact git
                               commit or version of every subproject
```

## Building it

Host: Linux with meson, glib and gobject-introspection installed (the host's
`g-ir-compiler` and GIRs are used), the Android SDK and NDK 27.1.12297006, pixiewood from
[gtk-android-builder](https://github.com/sp1ritCS/gtk-android-builder), and a running
x86_64 emulator with arm64 translation (or a device) on adb — set `ANDROID_SERIAL` when
more than one is attached.

```sh
pip install --target tools/pyvendor patchelf

work=~/build/gi-probe                       # any directory outside this checkout
cp -r recipe "$work"
sed "s|@TOOLS@|$PWD/tools|" recipe/pixiewood.xml.in > "$work/pixiewood.xml"
(cd "$work" && pixiewood prepare --sdk ~/Android/Sdk pixiewood.xml && pixiewood -v build --skip-gradle)

node scripts/pack-sysroot.mjs --source "$work" --tag <tag> --out dist \
    --ndk ~/Android/Sdk/ndk/27.1.12297006
gh release create <tag> dist/*.tar.gz dist/SHA256SUMS
```

`recipe/` is a minimal pixiewood app (`gi-probe`) whose only purpose is to make pixiewood
build the GTK/Libadwaita stack with introspection on; `pack-sysroot.mjs` leaves its own
library out. `tools/` holds the cross-build glue — `adb-run` (meson's `exe_wrapper` and
g-ir-scanner's `GI_CROSS_LAUNCHER`), the `g-ir-scanner` and `pkg-config` wrappers — and is
explained in gjsify's
[report on GI in a pixiewood APK](https://github.com/gjsify/gjsify/blob/main/docs/reports/2026-10-10-gi-in-a-pixiewood-apk.md).

The wraps track upstream branches, so two builds a week apart differ. What a given tarball
was built from is in its `share/android-sysroot/<abi>.json`.

## Tests

```sh
node --test scripts/
```

## License

The recipe and scripts are MIT ([LICENSE](LICENSE)). The binaries in the release assets
keep their own projects' terms; each tarball carries the texts under `share/licenses/`.
