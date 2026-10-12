/* Stage 1 of gjsify ADR 0104: do typelibs load, and does a call through
 * libffi reach the right library, inside a pixiewood APK? Every result is
 * logged as "GIPROBE ..." (logcat) and shown in the window. */

#include <adwaita.h>
#include <girepository/girepository.h>

static GIRepository *repo;
static GString *report;

static void
note (gboolean ok, const char *format, ...)
{
  va_list args;
  va_start (args, format);
  g_autofree char *line = g_strdup_vprintf (format, args);
  va_end (args);
  g_message ("GIPROBE %s %s", ok ? "PASS" : "FAIL", line);
  g_string_append_printf (report, "%s  %s\n", ok ? "✔" : "✘", line);
}

static void
require_all (void)
{
  static const char *const namespaces[][2] = {
    { "GLib", "2.0" }, { "GObject", "2.0" }, { "Gio", "2.0" },
    { "Gtk", "4.0" },  { "Adw", "1" },
  };
  const char *const *data_dirs = g_get_system_data_dirs ();
  g_autofree char *typelib_dir = g_build_filename (data_dirs[0], "girepository-1.0", NULL);

  note (g_file_test (typelib_dir, G_FILE_TEST_IS_DIR), "typelib dir %s", typelib_dir);
  gi_repository_prepend_search_path (repo, typelib_dir);

  for (gsize i = 0; i < G_N_ELEMENTS (namespaces); i++)
    {
      g_autoptr (GError) error = NULL;
      gint64 start = g_get_monotonic_time ();
      GITypelib *typelib = gi_repository_require (repo, namespaces[i][0], namespaces[i][1], 0, &error);
      gint64 took = g_get_monotonic_time () - start;
      note (typelib != NULL, "require %s-%s in %" G_GINT64_FORMAT " µs%s%s",
            namespaces[i][0], namespaces[i][1], took,
            error ? ": " : "", error ? error->message : "");
    }
}

static GIFunctionInfo *
find_function (const char *namespace_, const char *name)
{
  GIBaseInfo *info = gi_repository_find_by_name (repo, namespace_, name);
  if (info == NULL || !GI_IS_FUNCTION_INFO (info))
    {
      note (FALSE, "find %s.%s", namespace_, name);
      g_clear_pointer (&info, gi_base_info_unref);
      return NULL;
    }
  return GI_FUNCTION_INFO (info);
}

static void
invoke_glib (void)
{
  g_autoptr (GIFunctionInfo) fn = find_function ("GLib", "ascii_strup");
  if (fn == NULL)
    return;

  GIArgument in[2] = { { .v_string = (char *) "gjsify" }, { .v_ssize = -1 } };
  GIArgument ret = { 0 };
  g_autoptr (GError) error = NULL;
  gboolean ok = gi_function_info_invoke (fn, in, 2, NULL, 0, &ret, &error);
  note (ok && g_strcmp0 (ret.v_string, "GJSIFY") == 0, "invoke GLib.ascii_strup -> %s%s",
        ok ? ret.v_string : "(none)", error ? error->message : "");
  if (ok)
    g_free (ret.v_string);
}

static void
invoke_version (const char *namespace_, guint expected)
{
  g_autoptr (GIFunctionInfo) fn = find_function (namespace_, "get_major_version");
  if (fn == NULL)
    return;

  GIArgument ret = { 0 };
  g_autoptr (GError) error = NULL;
  gboolean ok = gi_function_info_invoke (fn, NULL, 0, NULL, 0, &ret, &error);
  note (ok && ret.v_uint32 == expected, "invoke %s.get_major_version -> %u (linked %u)%s",
        namespace_, ok ? ret.v_uint32 : 0, expected, error ? error->message : "");
}

static void
invoke_constructor (void)
{
  GIBaseInfo *info = gi_repository_find_by_gtype (repo, GTK_TYPE_LABEL);
  if (info == NULL || !GI_IS_OBJECT_INFO (info))
    {
      note (FALSE, "find_by_gtype GtkLabel");
      g_clear_pointer (&info, gi_base_info_unref);
      return;
    }
  note (TRUE, "find_by_gtype GtkLabel -> %s.%s", gi_base_info_get_namespace (info),
        gi_base_info_get_name (info));

  g_autoptr (GIFunctionInfo) ctor = gi_object_info_find_method (GI_OBJECT_INFO (info), "new");
  gi_base_info_unref (info);
  if (ctor == NULL)
    {
      note (FALSE, "find Gtk.Label.new");
      return;
    }

  GIArgument in = { .v_string = (char *) "made through libffi" };
  GIArgument ret = { 0 };
  g_autoptr (GError) error = NULL;
  gboolean ok = gi_function_info_invoke (ctor, &in, 1, NULL, 0, &ret, &error);
  GtkWidget *label = ok ? ret.v_pointer : NULL;
  gboolean is_label = label != NULL && GTK_IS_LABEL (label);
  note (is_label, "invoke Gtk.Label.new -> %s%s", is_label ? gtk_label_get_text (GTK_LABEL (label)) : "(none)",
        error ? error->message : "");
  if (label != NULL)
    g_object_unref (g_object_ref_sink (label));
}

static void
on_activate (GtkApplication *app)
{
  invoke_glib ();
  invoke_version ("Gtk", gtk_get_major_version ());
  invoke_version ("Adw", adw_get_major_version ());
  invoke_constructor ();

  GtkWidget *label = gtk_label_new (report->str);
  gtk_label_set_wrap (GTK_LABEL (label), TRUE);
  gtk_label_set_xalign (GTK_LABEL (label), 0);
  gtk_widget_set_margin_start (label, 12);
  gtk_widget_set_margin_end (label, 12);
  gtk_widget_set_margin_top (label, 12);

  GtkWidget *scrolled = gtk_scrolled_window_new ();
  gtk_scrolled_window_set_child (GTK_SCROLLED_WINDOW (scrolled), label);

  GtkWidget *view = adw_toolbar_view_new ();
  adw_toolbar_view_add_top_bar (ADW_TOOLBAR_VIEW (view), adw_header_bar_new ());
  adw_toolbar_view_set_content (ADW_TOOLBAR_VIEW (view), scrolled);

  GtkWidget *window = adw_application_window_new (app);
  gtk_window_set_title (GTK_WINDOW (window), "GI probe");
  adw_application_window_set_content (ADW_APPLICATION_WINDOW (window), view);
  gtk_window_present (GTK_WINDOW (window));
}

int
main (int argc, char **argv)
{
  report = g_string_new (NULL);
  repo = gi_repository_new ();
  require_all ();

  g_autoptr (AdwApplication) app = adw_application_new ("dev.gjsify.GiProbe", G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect (app, "activate", G_CALLBACK (on_activate), NULL);
  return g_application_run (G_APPLICATION (app), argc, argv);
}
