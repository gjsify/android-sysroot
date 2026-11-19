project('gi-probe', 'c', version: '0.1.0', meson_version: '>= 1.9')

gtk = dependency('gtk4')
adw = dependency('libadwaita-1')
girepository = dependency('girepository-2.0')

# The TLS backend GIO loads as a module: nothing links it, so it is built here rather than
# pulled in by a dependency. OpenSSL, not GnuTLS — gjsify ADR 0117 § 3 / ADR 0134: the
# trust anchors are handed to it as a file database at runtime, which needs no p11-kit.
subproject('glib-networking', default_options: [
  'gnutls=disabled',
  'openssl=enabled',
  'libproxy=disabled',
  'gnome_proxy=disabled',
  'environment_proxy=disabled',
  'tests=false',
])

executable('gi-probe', 'main.c',
  dependencies: [gtk, adw, girepository],
  android_exe_type: 'application',
  install: true,
)
