project('gi-probe', 'c', version: '0.1.0', meson_version: '>= 1.9')

gtk = dependency('gtk4')
adw = dependency('libadwaita-1')
girepository = dependency('girepository-2.0')

executable('gi-probe', 'main.c',
  dependencies: [gtk, adw, girepository],
  android_exe_type: 'application',
  install: true,
)
