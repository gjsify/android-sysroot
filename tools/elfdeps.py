"""DT_NEEDED closure of an Android ELF, resolved against the build tree."""

import glob
import os
import re
import subprocess

NDK = sorted(glob.glob(os.path.expanduser("~/Android/Sdk/ndk/*")))[-1]
PREBUILT = f"{NDK}/toolchains/llvm/prebuilt/linux-x86_64"
READELF = f"{PREBUILT}/bin/llvm-readelf"
ABI_TRIPLE = {"x86_64": "x86_64-linux-android", "aarch64": "aarch64-linux-android"}


def dynamic(path):
    out = subprocess.run([READELF, "-d", "-h", path], check=True, capture_output=True, text=True).stdout
    needed = re.findall(r"\(NEEDED\)\s+Shared library: \[(.+?)\]", out)
    runpath = re.findall(r"\((?:RUNPATH|RPATH)\)\s+Library (?:runpath|rpath): \[(.+?)\]", out)
    machine = "aarch64" if "AArch64" in out else "x86_64"
    return needed, [p for entry in runpath for p in entry.split(":")], machine


def build_root(path):
    directory = os.path.dirname(os.path.abspath(path))
    while directory != "/":
        if os.path.exists(os.path.join(directory, "build.ninja")):
            return directory
        directory = os.path.dirname(directory)
    return None


def index_libraries(root):
    found = {}
    for dirpath, _, files in os.walk(root):
        for name in files:
            if ".so" in name and name not in found:
                found[name] = os.path.join(dirpath, name)
    return found


def resolve_needed(binary):
    """Map every soname in the closure to a host path, or None for system libraries."""
    _, _, machine = dynamic(binary)
    root = build_root(binary)
    index = index_libraries(root) if root else {}
    sysroot = f"{PREBUILT}/sysroot/usr/lib/{ABI_TRIPLE[machine]}"
    resolved = {}
    queue = [binary]
    while queue:
        needed, runpath, _ = dynamic(queue.pop())
        for name in needed:
            if name in resolved:
                continue
            # The NDK sysroot holds link-time stubs of the system libraries
            # (libc.so lacks __register_atfork); the device has the real ones.
            runpath = [d for d in runpath if root and os.path.abspath(d).startswith(root)]
            path = next((os.path.join(d, name) for d in runpath if os.path.isfile(os.path.join(d, name))), None)
            path = path or index.get(name)
            if path is None and name == "libc++_shared.so":
                path = os.path.join(sysroot, name)
            resolved[name] = path
            if path is not None:
                queue.append(path)
    return resolved
