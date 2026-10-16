# Building the prefix in CI

The prefix used to be built by hand, because g-ir-scanner has to *run* a dumper binary
compiled for the target and a GitHub runner has no Android device. It does not need one:
`tools/qemu-run` runs that binary under qemu-user against a bionic runtime unpacked from
the official Android system image, and the result is byte-identical to a hand build.

`.github/workflows/build.yml` is `scripts/ci-build` plus caching. The same script is what a
local container run executes, so what is tested before a push is the code path CI takes.

## Running the target binary without a device

g-ir-scanner compiles a small dumper against the library it is scanning, runs it, and reads
the introspection data back. Cross-building, it runs the dumper through
`GI_CROSS_LAUNCHER`; meson runs target binaries through `exe_wrapper`. Both point at
`tools/qemu-run`, which executes

```
qemu-<arch>-static -L <android root> <android root>/system/bin/linker64 <binary>
```

— Android's own dynamic linker and libc, not the NDK's stubs, because the dumper links
against the stack being built and that stack expects bionic. `tools/adb-run` is still
there as the device path, but nothing uses it by default any more.

## Where bionic comes from

`tools/make-android-root` takes a system image from the Android SDK's system-image
repository and unpacks 243 libraries (87 MB) out of it, with no root and no emulator:

1. `system.img` is a GPT disk whose only real payload is a `super` dynamic-partition
   container at byte 2097152; inside it the `system` **erofs** filesystem starts at byte
   3145728. `fsck.erofs --extract` reads it from that offset.
2. The real `linker64` and the bionic libraries are not in `/system/lib64` but in
   `system/apex/com.android.runtime.apex`, which is a zip holding `apex_payload.img`, an
   **ext4** image. `debugfs -R "rdump / <dest>"` extracts it unprivileged. ICU comes from
   `com.android.i18n.apex` the same way.
3. The libraries the dumper needs are resolved from a seed set; `libvulkan.so` and
   `libjnigraphics.so` are seeded explicitly, because the NDK stubs lack the
   `AImageDecoder_*` symbols gdk-pixbuf resolves against.

The image's revision does not reach the output: r06 and r07 produce the same prefix, byte
for byte. The 1.9 GB download happens only on a cache miss — it is the 87 MB result that is
cached, not the image.

## Why it runs in a Fedora container

The scanner uses the *host's* `g-ir-compiler` and the host's GIRs, so the typelibs carry
whatever version the host has. `ubuntu-latest` does not ship gobject-introspection 1.86.0
or meson 1.11.2, which is what the releases are built with, so the job runs in
`fedora:44` — the distribution of the machine the releases were cut on.

`gtk4-devel` and `pango-devel` are installed for their GIRs rather than their libraries:
libadwaita's scanner invocation carries no in-tree include path at all, so `Gtk-4.0.gir` is
resolved from `/usr/share/gir-1.0`. A hand build on a GTK workstation never notices.

Java is not installed; `pixiewood build --skip-gradle` stops before the APK, which this
build does not want.

## What byte identity depends on

Reproducing a release needs all of these to match, and the workflow has a knob for each:

| Input | How it is fixed |
|---|---|
| host gobject-introspection, glib, meson | the `fedora:44` container |
| NDK | pinned by version and sha1 |
| every subproject's commit | `--pin <abi.json>` from the release's own manifest |
| libjpeg-turbo's build day | `--build-date`, see below |
| the build directory's path | `CI_BUILD_WORK`, see below |
| the NDK's path | the `ndk-root` workflow input, see below |

**libjpeg-turbo** bakes `datetime.now()` into `JVERSION` and the `BUILD` macro, so
`libjpeg.so` and `libturbojpeg.so` carry the calendar day of the build. `ci-build
--build-date YYYYMMDD` patches that out of the realized subproject, between `prepare` (which
is what materializes it) and `build`.

**Two directory paths** reach every library: the build directory's and the NDK's. meson
links an rpath placeholder whose length it derives from the build-time rpath, and that
names both — `$ORIGIN`-relative entries for the subprojects, and the NDK's sysroot
absolutely. Build under a name of a different length and every `.so` differs, in the
padding and in everything that shifts behind the grown `.dynstr`. Nothing of either path
itself ends up in the binaries. The manifest records both, as `buildRoot` and `ndkRoot`,
so a later rebuild can reproduce them; the workflow takes them from the release it is
comparing against, or from its `build-root` and `ndk-root` inputs for a release cut before
the manifest carried them.

A symlink is not enough. Pointed at the NDK through one, the rpath comes out the right
length and every section lands at the right offset — and the 20 bytes of
`.note.gnu.build-id` still differ, because the toolchain resolves the link. The NDK has to
be copied to the path, which is what the workflow does.

**Source pinning** works even though the wraps track branches: `git fetch --depth 1 origin
<sha>` is accepted by gitlab.gnome.org, gitlab.freedesktop.org and github, and pixiewood
takes a per-dependency `revision`. `scripts/pin-sources.mjs` writes it for the four declared
dependencies (glib, fontconfig, gtk, libadwaita); their transitive wraps are
`wrap-redirect`s into those trees, so pinning four pins 22 of 24 sources. The two that stay
floating are **pango** (`revision = main` in `gtk/subprojects/pango.wrap`) and **freetype2**
(`revision = master` in `fontconfig/subprojects/freetype2.wrap`) — neither is reachable
through pixiewood's `revision` attribute.

## A cold build is not an incremental one

`subprojects/gtk/gtk/Gdk-4.0.gir` declares no dependency on any `.gir`, so a cold, fully
parallel build can scan Gdk before `PangoCairo-1.0.gir` exists. Six of the 21 gir targets
have no gir dependencies at all. An incremental rebuild never hits it, which is why the hand
builds never saw it; `ci-build` retries the build up to three times, and a retry only picks
up what the race dropped, since ninja skips everything it considers done.

## The result

A cold run of `ci-build --pin --build-date` against the `2026.10.12` x86_64 release, in a
`fedora:44` container with freshly cloned sources (3336 ninja targets, a 1.7 GB build tree,
4m16s wall on a 32-thread workstation including the package install):

```
files: 1244 built, 1246 reference
identical: 1242
only in the build: 1
    share/licenses/glib/COPYING
only in the reference: 3
    share/licenses/gobject-introspection/COPYING{,.GPL,.LGPL}
differing content: 1
    share/android-sysroot/x86_64.json
```

All 21 typelibs and all 34 shared objects are identical. The three differences are all
accounted for:

- `share/licenses/glib/COPYING` is a **dangling absolute symlink** in the release and a real
  file in the build — the bug `pack-sysroot.mjs` fixed right after that release was cut.
- The gobject-introspection licences come from a **stale subproject checkout** left in the
  hand-build tree. The dependency resolves to the host's 1.86.0 (`meson-log.txt`:
  `Dependency gobject-introspection-1.0 ... found: YES 1.86.0`), so nothing was built from
  it; a clean tree has no such directory and no such licences.
- The manifest differs in `tag`, in the new `buildRoot`, and in the `sources` entry for that
  same stale checkout. Every shared `sources` commit, and the `libraries`, `typelibs` and
  `ndk` fields, are equal.

`scripts/compare-sysroot <built> <reference>` is that check; it exits non-zero on any
differing content.

## What is left

- **pango and freetype2 float.** Two consecutive builds can still differ, and nothing in
  pixiewood's recipe format can pin them.
- **The gir ordering race is worked around, not fixed.** The fix belongs in gtk's
  `meson.build`, upstream.
- **`gobject-introspection` in the release manifest** is a stale entry, not a real input.
