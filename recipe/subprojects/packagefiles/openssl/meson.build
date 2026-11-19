# SPDX-License-Identifier: MIT
# OpenSSL has no meson build, and wrapdb's port stops at 3.0 (end of life). This runs
# OpenSSL's own Configure and make through meson's external_project, so glib-networking's
# `dependency('openssl')` resolves to it and `meson install` puts libssl.so and
# libcrypto.so under lib/<abi> like every other library of the stack.
project('openssl', 'c', version: '3.5.9', meson_version: '>= 1.9')

ep = import('unstable-external_project')

openssl = ep.add_project('configure-android',
  configure_options: [
    '--prefix=@PREFIX@',
    '--libdir=@LIBDIR@',
    '--bindir=@BINDIR@',
    'shared',
    # A library for glib-networking and nothing else: no openssl(1), no man pages, no
    # test programs, no dlopen'ed providers or engines (the default and base providers
    # are built into libcrypto), no QUIC.
    'no-apps',
    'no-docs',
    'no-tests',
    'no-ui-console',
    'no-engine',
    'no-module',
    'no-legacy',
    'no-quic',
  ],
  cross_configure_options: [],
)

openssl_dep = declare_dependency(
  dependencies: [openssl.dependency('ssl'), openssl.dependency('crypto')],
  version: meson.project_version(),
)
meson.override_dependency('openssl', openssl_dep)
meson.override_dependency('libssl', openssl_dep)
meson.override_dependency('libcrypto', openssl.dependency('crypto'))
