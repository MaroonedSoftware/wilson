using System.Text.Encodings.Web;
using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>The colour scheme an app is told to draw in: always the one Wilson is showing, never automatic.</summary>
public enum AppColorScheme
{
    Light,
    Dark,
}

/// <summary>
/// The document an operator app runs as, which is `appDocument` in the web app's `lib/apps.ts` to the byte.
/// `AppHostFixtureTests` and the web app's `app.host-fixture.test.ts` read one recorded copy, so the two
/// cannot drift. The policy is explained there, and what WebKit does with it in `CLAUDE.md`.
/// </summary>
public static class AppDocument
{
    /// <summary>What an app's document may load: its own inline script and style, and `data:` images, fonts and media.</summary>
    public const string ContentSecurityPolicy =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'";

    /// <summary>The iframe's `sandbox` value. Scripts only: no same-origin, popups, forms or top navigation.</summary>
    public const string Sandbox = "allow-scripts";

    /// <summary>What the host says to an app's frame when it hands over the app's port.</summary>
    public const string ConnectMessage = "wilson.connect";

    /// <summary>The methods `window.wilson` offers, granted or not, in the web app's order.</summary>
    public static readonly IReadOnlyList<string> MethodNames = ["listCards", "getCard", "listBoardColumns", "listProjectActivity", "getProjectStats", "openCard"];

    private static readonly JsonSerializerOptions ScriptOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The wire spelling of a grant, or null for one this build does not know, which can reach nothing.</summary>
    public static string? GrantName(AppGrant grant) => grant switch
    {
        AppGrant.BoardRead => "board.read",
        AppGrant.ActivityRead => "activity.read",
        AppGrant.StatsRead => "stats.read",
        _ => null,
    };

    /// <summary>What a person is told a grant lets an app read, in `lib/apps.ts`'s words.</summary>
    public static string GrantLabel(AppGrant grant) => grant switch
    {
        AppGrant.BoardRead => "Board",
        AppGrant.ActivityRead => "Activity",
        AppGrant.StatsRead => "Stats",
        _ => "Unknown",
    };

    /// <summary>The scheme as `window.wilson.colorScheme` spells it.</summary>
    public static string SchemeName(AppColorScheme scheme) => scheme == AppColorScheme.Dark ? "dark" : "light";

    /// <summary>
    /// The policy, the client, then the app's HTML exactly as installed. The policy comes first so it is
    /// in force before the app's first byte is parsed.
    /// </summary>
    public static string Build(string html, string project, IEnumerable<AppGrant> grants, AppColorScheme colorScheme)
    {
        ArgumentNullException.ThrowIfNull(html);
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(grants);

        var names = grants.Select(GrantName).OfType<string>().ToList();
        return $"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"{ContentSecurityPolicy}\"><script>{Client(project, names, SchemeName(colorScheme))}</script>{html}";
    }

    /// <summary>JSON that is safe inside a script element: no `&lt;`, so nothing in it can end the element.</summary>
    private static string ScriptJson<T>(T value) => JsonSerializer.Serialize(value, ScriptOptions).Replace("<", "\\u003c", StringComparison.Ordinal);

    /// <summary>
    /// `window.wilson`. A convenience for the app that enforces nothing, since the app's own code can
    /// replace it. The host checks every request.
    /// </summary>
    private static string Client(string project, IReadOnlyList<string> grants, string colorScheme) =>
        "(() => {\n"
        + $"const names = {ScriptJson(MethodNames)};\n"
        + """
          const waiting = new Map();
          const early = [];
          const changeListeners = new Set();
          const schemeListeners = new Set();

          """
        + $"let colorScheme = {ScriptJson(colorScheme)};\n"
        + """
          let port;
          let next = 0;
          const listen = listeners => listener => {
              listeners.add(listener);
              return () => listeners.delete(listener);
          };
          const applyScheme = () => {
              document.documentElement.style.colorScheme = colorScheme;
          };
          applyScheme();
          addEventListener('message', event => {

          """
        + $"    if (port || event.source !== parent || event.data !== {ScriptJson(ConnectMessage)} || !event.ports[0]) return;\n"
        + """
              port = event.ports[0];
              port.onmessage = ({ data }) => {
                  if (data.event === 'change') {
                      for (const listener of [...changeListeners]) listener();
                      return;
                  }
                  if (data.event === 'colorScheme') {
                      if (data.colorScheme === colorScheme) return;
                      colorScheme = data.colorScheme;
                      applyScheme();
                      for (const listener of [...schemeListeners]) listener(colorScheme);
                      return;
                  }
                  const call = waiting.get(data.id);
                  if (!call) return;
                  waiting.delete(data.id);
                  if (data.ok) call.resolve(data.result);
                  else call.reject(new Error(data.error));
              };
              for (const request of early.splice(0)) port.postMessage(request);
          });
          const method = name => (...args) =>
              new Promise((resolve, reject) => {
                  const id = ++next;
                  waiting.set(id, { resolve, reject });
                  if (port) port.postMessage({ id, method: name, args });
                  else early.push({ id, method: name, args });
              });
          window.wilson = Object.freeze({

          """
        + $"    project: {ScriptJson(project)},\n"
        + $"    grants: Object.freeze({ScriptJson(grants)}),\n"
        + """
              get colorScheme() {
                  return colorScheme;
              },
              onChange: listen(changeListeners),
              onColorSchemeChange: listen(schemeListeners),
              ...Object.fromEntries(names.map(name => [name, method(name)])),
          });
          })();
          """;
}
