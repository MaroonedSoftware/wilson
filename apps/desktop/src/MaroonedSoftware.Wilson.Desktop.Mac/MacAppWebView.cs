using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>Which of the web view's own locks are on. Only `tools/Walk -- app-probe` ever asks for fewer than all of them.</summary>
[Flags]
internal enum AppWebLocks
{
    None = 0,
    HostPolicy = 1,
    NetworkRules = 2,
    NoWebRtc = 4,
    Navigation = 8,
    NoPreconnect = 16,
    All = HostPolicy | NetworkRules | NoWebRtc | Navigation | NoPreconnect,
}

/// <summary>
/// The WKWebView one operator app runs in, shut as far as WebKit allows before anything loads. It has no
/// cookies or storage of its own, its network is refused at the engine, WebRTC is off, every navigation
/// is decided before a request is made, and the bridge to native code is in a world the app cannot see.
/// `CLAUDE.md` under Operator apps holds what each of these was measured to do. Call everything on the UI thread,
/// as AppKit requires.
/// </summary>
public sealed class MacAppWebView : IDisposable
{
    private const string WebKit = "/System/Library/Frameworks/WebKit.framework/WebKit";
    private const nint PolicyCancel = 0;
    private const nint PolicyAllow = 1;
    private const nint InjectAtDocumentEnd = 1;

    /// <summary>Delegates are looked up by their own pointer, as a C callback can carry nothing else.</summary>
    private static readonly ConcurrentDictionary<nint, MacAppWebView> Open = new();

    private static readonly Lazy<nint> DelegateClass = new(DefineDelegateClass);
    private static TaskCompletionSource<nint>? _rules;

    private readonly AppNavigationPolicy _navigation = new();
    private readonly AppWebLocks _locks;
    private readonly string _document;
    private readonly AppColorScheme _colorScheme;
    private readonly nint _delegate;
    private readonly nint _world;
    private readonly nint _contentController;
    private nint _webView;
    private bool _left;

    /// <summary>Everything locked, which is the only way the app itself ever makes one.</summary>
    public MacAppWebView(string document, AppColorScheme colorScheme)
        : this(document, colorScheme, AppWebLocks.All)
    {
    }

    internal MacAppWebView(string document, AppColorScheme colorScheme, AppWebLocks locks)
    {
        ArgumentNullException.ThrowIfNull(document);

        _document = document;
        _colorScheme = colorScheme;
        _locks = locks;
        NativeLibrary.Load(WebKit);

        var pool = ObjC.PoolPush();
        try
        {
            _delegate = ObjC.Send(ObjC.Send(DelegateClass.Value, ObjC.Sel("alloc")), ObjC.Sel("init"));
            Open[_delegate] = this;

            var configuration = ObjC.Send(ObjC.Send(ObjC.Class("WKWebViewConfiguration"), ObjC.Sel("alloc")), ObjC.Sel("init"));
            ObjC.Send(configuration, ObjC.Sel("setWebsiteDataStore:"), ObjC.Send(ObjC.Class("WKWebsiteDataStore"), ObjC.Sel("nonPersistentDataStore")));
            Lock(ObjC.Send(configuration, ObjC.Sel("preferences")));

            _contentController = ObjC.Send(configuration, ObjC.Sel("userContentController"));
            ObjC.Send(_contentController, ObjC.Sel("retain"));
            _world = ObjC.Send(ObjC.Send(ObjC.Class("WKContentWorld"), ObjC.Sel("worldWithName:"), ObjC.Autoreleased(AppHostPage.ContentWorld)), ObjC.Sel("retain"));
            ObjC.Send(_contentController, ObjC.Sel("addScriptMessageHandler:contentWorld:name:"), _delegate, _world, ObjC.Autoreleased(AppHostPage.MessageHandler));

            _webView = ObjC.Send(ObjC.Send(ObjC.Class("WKWebView"), ObjC.Sel("alloc")), ObjC.Sel("initWithFrame:configuration:"), default(CGRect), configuration);
            ObjC.Send(configuration, ObjC.Sel("release"));
            ObjC.Send(_webView, ObjC.Sel("setNavigationDelegate:"), _delegate);
            ObjC.Send(_webView, ObjC.Sel("setUIDelegate:"), _delegate);

            // A file dropped on a web view is a navigation to it. Refused anyway, but it would close the app.
            ObjC.Send(_webView, ObjC.Sel("unregisterDraggedTypes"));
        }
        finally
        {
            ObjC.PoolPop(pool);
        }
    }

    /// <summary>A request from the app, as JSON text, on the UI thread.</summary>
    public event Action<string>? Received;

    /// <summary>The app tried to leave its page. It has been stopped, and should be taken away.</summary>
    public event Action? Left;

    /// <summary>It could not be started or its process died, with what to say about it. Nothing of the app is running.</summary>
    public event Action<string>? Failed;

    /// <summary>The NSView, for the window to hold. Empty once disposed.</summary>
    public nint View => _webView;

    /// <summary>
    /// Loads the app, which waits on the network rules. If those cannot be had the app is not loaded at
    /// all, rather than being run with only the locks that are left.
    /// </summary>
    public async Task StartAsync()
    {
        var rules = (_locks & AppWebLocks.NetworkRules) != 0 ? await RulesAsync() : 0;
        if (_webView == 0)
        {
            return;
        }

        if ((_locks & AppWebLocks.NetworkRules) != 0)
        {
            if (rules == 0)
            {
                Failed?.Invoke("WebKit would not compile the rules that keep an app off the network.");
                return;
            }

            ObjC.Send(_contentController, ObjC.Sel("addContentRuleList:"), rules);
        }

        var pool = ObjC.PoolPush();
        try
        {
            var source = ObjC.Autoreleased(AppHostPage.Script(_document, _colorScheme));
            var script = ObjC.Send(ObjC.Class("WKUserScript"), ObjC.Sel("alloc"));
            script = ObjC.SendScript(script, ObjC.Sel("initWithSource:injectionTime:forMainFrameOnly:inContentWorld:"), source, InjectAtDocumentEnd, true, _world);
            ObjC.Send(_contentController, ObjC.Sel("addUserScript:"), script);
            ObjC.Send(script, ObjC.Sel("release"));

            var html = (_locks & AppWebLocks.HostPolicy) != 0 ? AppHostPage.Html : AppHostPage.Html.Replace("""<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">""", string.Empty, StringComparison.Ordinal);
            ObjC.Send(_webView, ObjC.Sel("loadHTMLString:baseURL:"), ObjC.Autoreleased(html), 0);
        }
        finally
        {
            ObjC.PoolPop(pool);
        }
    }

    /// <summary>Gives the app an answer or an event, as JSON text.</summary>
    public void Send(string json)
    {
        if (_webView == 0)
        {
            return;
        }

        var pool = ObjC.PoolPush();
        try
        {
            ObjC.Send(_webView, ObjC.Sel("evaluateJavaScript:inFrame:inContentWorld:completionHandler:"), ObjC.Autoreleased(AppHostPage.Receive(json)), 0, _world, 0);
        }
        finally
        {
            ObjC.PoolPop(pool);
        }
    }

    public void Dispose()
    {
        if (_webView == 0)
        {
            return;
        }

        var pool = ObjC.PoolPush();
        try
        {
            ObjC.Send(_webView, ObjC.Sel("setNavigationDelegate:"), 0);
            ObjC.Send(_webView, ObjC.Sel("setUIDelegate:"), 0);
            ObjC.Send(_webView, ObjC.Sel("stopLoading"));
            ObjC.Send(_contentController, ObjC.Sel("removeScriptMessageHandlerForName:contentWorld:"), ObjC.Autoreleased(AppHostPage.MessageHandler), _world);
            ObjC.Send(_contentController, ObjC.Sel("removeAllUserScripts"));
            ObjC.Send(_webView, ObjC.Sel("removeFromSuperview"));
            ObjC.Send(_webView, ObjC.Sel("release"));
            ObjC.Send(_world, ObjC.Sel("release"));
            ObjC.Send(_contentController, ObjC.Sel("release"));
            Open.TryRemove(_delegate, out _);
            ObjC.Send(_delegate, ObjC.Sel("release"));
            _webView = 0;
        }
        finally
        {
            ObjC.PoolPop(pool);
        }
    }

    /// <summary>Compiled once for the process. A failure is kept: it will not come out differently on a second try.</summary>
    private static unsafe Task<nint> RulesAsync()
    {
        if (_rules is not null)
        {
            return _rules.Task;
        }

        _rules = new TaskCompletionSource<nint>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pool = ObjC.PoolPush();
        try
        {
            var store = ObjC.Send(ObjC.Class("WKContentRuleListStore"), ObjC.Sel("defaultStore"));
            var finished = ObjC.GlobalBlock((nint)(delegate* unmanaged<nint, nint, nint, void>)&RulesCompiled);
            ObjC.Send(store, ObjC.Sel("compileContentRuleListForIdentifier:encodedContentRuleList:completionHandler:"), ObjC.Autoreleased("wilson-app-no-network"), ObjC.Autoreleased(AppHostPage.NetworkRules), finished);
        }
        finally
        {
            ObjC.PoolPop(pool);
        }

        return _rules.Task;
    }

    private static unsafe nint DefineDelegateClass() =>
        ObjC.DefineClass(
            "WilsonAppWebViewDelegate",
            ["WKNavigationDelegate", "WKUIDelegate", "WKScriptMessageHandler"],
            [
                ("webView:decidePolicyForNavigationAction:decisionHandler:", (nint)(delegate* unmanaged<nint, nint, nint, nint, nint, void>)&DecidePolicy, "v@:@@@?"),
                ("webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:", (nint)(delegate* unmanaged<nint, nint, nint, nint, nint, nint, nint>)&NoNewWindow, "@@:@@@@"),
                ("userContentController:didReceiveScriptMessage:", (nint)(delegate* unmanaged<nint, nint, nint, nint, void>)&MessageReceived, "v@:@@"),
                ("webViewWebContentProcessDidTerminate:", (nint)(delegate* unmanaged<nint, nint, nint, void>)&ProcessDied, "v@:@"),
            ]);

    [UnmanagedCallersOnly]
    private static void RulesCompiled(nint block, nint list, nint error)
    {
        if (list != 0)
        {
            ObjC.Send(list, ObjC.Sel("retain"));
        }
        else
        {
            Trace.WriteLine($"app web view: rules: {ObjC.Text(ObjC.Send(error, ObjC.Sel("description")))}");
        }

        _rules!.TrySetResult(list);
    }

    /// <summary>Never throws, as an exception cannot cross into native code. A failure refuses the navigation.</summary>
    [UnmanagedCallersOnly]
    private static void DecidePolicy(nint self, nint selector, nint webView, nint action, nint decisionHandler)
    {
        var decision = AppNavigationDecision.Left;
        try
        {
            if (Open.TryGetValue(self, out var view))
            {
                decision = view.Decide(action);
            }
        }
        catch (Exception failure)
        {
            Trace.WriteLine($"app web view: navigation: {failure.Message}");
        }

        ObjC.InvokeBlock(decisionHandler, decision == AppNavigationDecision.Allow ? PolicyAllow : PolicyCancel);
    }

    /// <summary>A window is only ever made by returning one, so returning none is the whole of this.</summary>
    [UnmanagedCallersOnly]
    private static nint NoNewWindow(nint self, nint selector, nint webView, nint configuration, nint action, nint features) => 0;

    [UnmanagedCallersOnly]
    private static void MessageReceived(nint self, nint selector, nint controller, nint message)
    {
        try
        {
            if (Open.TryGetValue(self, out var view))
            {
                view.Receive(message);
            }
        }
        catch (Exception failure)
        {
            Trace.WriteLine($"app web view: message: {failure.Message}");
        }
    }

    [UnmanagedCallersOnly]
    private static void ProcessDied(nint self, nint selector, nint webView)
    {
        try
        {
            if (Open.TryGetValue(self, out var view))
            {
                view.Failed?.Invoke("The app's page stopped running.");
            }
        }
        catch (Exception failure)
        {
            Trace.WriteLine($"app web view: process: {failure.Message}");
        }
    }

    /// <summary>
    /// Off before the view exists, as a preference set later may not reach a running page. These are
    /// private to WebKit, so a macOS without one still runs the app, with the limit the web app has
    /// (`README.md`), and says so here. `_setPeerConnectionEnabled:` has no public equivalent.
    /// </summary>
    private void Lock(nint preferences)
    {
        ObjC.SendFlag(preferences, ObjC.Sel("setFraudulentWebsiteWarningEnabled:"), false);
        ObjC.SendFlag(preferences, ObjC.Sel("setJavaScriptCanOpenWindowsAutomatically:"), false);
        SetPrivate(preferences, "_setDNSPrefetchingEnabled:");
        if ((_locks & AppWebLocks.NoWebRtc) != 0)
        {
            SetPrivate(preferences, "_setPeerConnectionEnabled:");
        }

        if ((_locks & AppWebLocks.NoPreconnect) != 0)
        {
            TurnOffFeatures(preferences, "LinkPreconnect", "LinkPreconnectEarlyHintsEnabled");
        }
    }

    /// <summary>
    /// `LinkPreconnect` also gates the connection WebKit opens when a link is pressed, before the sandbox
    /// or anything else has said no. The rule list does not see that one, and no delegate is told of it, so
    /// this is the only thing that stops an app naming a host by pressing a link of its own.
    /// </summary>
    private static void TurnOffFeatures(nint preferences, params string[] keys)
    {
        var preferencesClass = ObjC.Class("WKPreferences");
        if (!ObjC.Responds(preferencesClass, "_features") || !ObjC.Responds(preferences, "_setEnabled:forFeature:"))
        {
            Trace.WriteLine("app web view: this WebKit lists no features");
            return;
        }

        var features = ObjC.Send(preferencesClass, ObjC.Sel("_features"));
        var count = ObjC.Send(features, ObjC.Sel("count"));
        var found = 0;
        for (nint index = 0; index < count; index++)
        {
            var feature = ObjC.Send(features, ObjC.Sel("objectAtIndex:"), index);
            if (keys.Contains(ObjC.Text(ObjC.Send(feature, ObjC.Sel("key"))), StringComparer.Ordinal))
            {
                ObjC.SendFeature(preferences, ObjC.Sel("_setEnabled:forFeature:"), false, feature);
                found++;
            }
        }

        if (found != keys.Length)
        {
            Trace.WriteLine($"app web view: found {found} of the features {string.Join(", ", keys)}");
        }
    }

    private static void SetPrivate(nint preferences, string selector)
    {
        if (ObjC.Responds(preferences, selector))
        {
            ObjC.SendFlag(preferences, ObjC.Sel(selector), false);
        }
        else
        {
            Trace.WriteLine($"app web view: this WebKit has no {selector}");
        }
    }

    private AppNavigationDecision Decide(nint action)
    {
        var target = ObjC.Send(action, ObjC.Sel("targetFrame"));
        bool? mainFrame = target == 0 ? null : ObjC.SendBool(target, ObjC.Sel("isMainFrame"));
        var url = ObjC.Text(ObjC.Send(ObjC.Send(ObjC.Send(action, ObjC.Sel("request")), ObjC.Sel("URL")), ObjC.Sel("absoluteString")));
        var decision = _navigation.Decide(mainFrame, url, ObjC.Send(action, ObjC.Sel("navigationType")));
        if ((_locks & AppWebLocks.Navigation) == 0)
        {
            return AppNavigationDecision.Allow;
        }

        if (decision == AppNavigationDecision.Left)
        {
            Leave();
        }

        return decision;
    }

    /// <summary>Only the host script can reach the handler, and it runs in the main frame. The check is for if that ever stops being so.</summary>
    private void Receive(nint message)
    {
        var frame = ObjC.Send(message, ObjC.Sel("frameInfo"));
        if (frame == 0 || !ObjC.SendBool(frame, ObjC.Sel("isMainFrame")))
        {
            return;
        }

        var body = ObjC.Send(message, ObjC.Sel("body"));
        if (body == 0 || !ObjC.SendBool(body, ObjC.Sel("isKindOfClass:"), ObjC.Class("NSString")))
        {
            return;
        }

        var text = ObjC.Text(body);
        if (text == AppHostPage.LeftMessage)
        {
            Leave();
        }
        else if (text is not null)
        {
            Received?.Invoke(text);
        }
    }

    private void Leave()
    {
        if (!_left)
        {
            _left = true;
            Left?.Invoke();
        }
    }
}
