using System.Text.Encodings.Web;
using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>
/// The page a native web view holds around an operator app, which does what `AppFrame.tsx` and the web
/// app's response headers do. The app stays in the sandboxed frame it has on the web, in the document
/// <see cref="AppDocument"/> builds, so everything measured about that frame still applies. What a browser
/// gets from elsewhere is here: the page's `frame-src 'none'`, which a load with no response has to carry
/// in a meta element, and the frame and its port, from a script that runs apart from the page.
/// </summary>
public static class AppHostPage
{
    /// <summary>The name native code answers to. The script below is the only thing that can see it (`CLAUDE.md`).</summary>
    public const string MessageHandler = "wilsonApp";

    /// <summary>The isolated world that name and script live in. An app's frame runs in the page's own and cannot reach this one.</summary>
    public const string ContentWorld = "wilson-app-host";

    /// <summary>
    /// Refuses every request a page can make, at the engine. The policy already refuses nearly all of them,
    /// but not `rel=preconnect`, which opens a connection to any host an app names. Measured, in
    /// `tools/Walk -- app-probe`. Alternation is left out because WebKit's rule compiler refuses it.
    /// </summary>
    public const string NetworkRules =
        """[{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^file:"},"action":{"type":"block"}}]""";

    /// <summary>What goes around the frame. The policy is `frame-src 'none'` alone, as the frame inherits it and needs its own script to run.</summary>
    public const string Html =
        """<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body></body></html>""";

    private static readonly JsonSerializerOptions ScriptOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>What tells native code that the frame loaded a second time.</summary>
    public const string LeftMessage = "left";

    /// <summary>
    /// Runs once in <see cref="ContentWorld"/> on the host page. It makes the frame with its listener
    /// already on, so the first load cannot be missed, and passes JSON text each way, as nothing else
    /// crosses into native code. A second load means the app tried to leave, as on the web.
    /// </summary>
    public static string Script(string document, AppColorScheme colorScheme)
    {
        ArgumentNullException.ThrowIfNull(document);

        return $$"""
            (() => {
            const native = webkit.messageHandlers.{{MessageHandler}};
            const channel = new MessageChannel();
            const port = channel.port1;
            const frame = document.createElement('iframe');
            const applyScheme = scheme => {
                document.documentElement.style.colorScheme = scheme;
                frame.style.colorScheme = scheme;
            };
            port.onmessage = ({ data }) => {
                let text;
                try {
                    text = JSON.stringify(data);
                } catch {
                    return;
                }
                if (typeof text === 'string') native.postMessage(text);
            };
            globalThis.wilsonAppReceive = text => {
                const data = JSON.parse(text);
                if (data.event === 'colorScheme') applyScheme(data.colorScheme);
                port.postMessage(data);
            };
            let loads = 0;
            frame.addEventListener('load', () => {
                loads += 1;
                if (loads > 1) {
                    port.close();
                    native.postMessage({{JsonSerializer.Serialize(LeftMessage, ScriptOptions)}});
                    return;
                }
                frame.contentWindow.postMessage({{JsonSerializer.Serialize(AppDocument.ConnectMessage, ScriptOptions)}}, '*', [channel.port2]);
            });
            applyScheme({{JsonSerializer.Serialize(AppDocument.SchemeName(colorScheme), ScriptOptions)}});
            frame.setAttribute('sandbox', {{JsonSerializer.Serialize(AppDocument.Sandbox, ScriptOptions)}});
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.srcdoc = {{JsonSerializer.Serialize(document, ScriptOptions)}};
            document.body.append(frame);
            })();
            """;
    }

    /// <summary>A call that gives the host script a message to pass on. The message is a string in it, never code.</summary>
    public static string Receive(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        return $"wilsonAppReceive({JsonSerializer.Serialize(json, ScriptOptions)})";
    }
}
