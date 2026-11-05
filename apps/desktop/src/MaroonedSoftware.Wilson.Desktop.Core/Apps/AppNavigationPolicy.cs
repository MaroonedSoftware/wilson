namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>What the web view does with a navigation it is asked about.</summary>
public enum AppNavigationDecision
{
    /// <summary>The host page, or the app's own document, on the way in. Each happens once.</summary>
    Allow,

    /// <summary>Stopped, and nothing more said: a frame an app made, which its policy refuses on the web too.</summary>
    Refuse,

    /// <summary>Stopped, and the app is closed: it tried to go somewhere.</summary>
    Left,
}

/// <summary>
/// Every navigation in an open app's web view, decided before any request is made. On the web a frame's
/// self-navigation can only be stopped by a response header and then noticed, and this is the stronger
/// thing a native view allows. An app has one document for its whole life, so this allows exactly two
/// navigations, in order, and nothing after.
/// </summary>
public sealed class AppNavigationPolicy
{
    private const string Blank = "about:blank";
    private const string SourceDocument = "about:srcdoc";

    /// <summary>`WKNavigationTypeOther`, which is what making a frame reports. Anything else is a person or a script going somewhere.</summary>
    private const long TypeOther = -1;

    private bool _hostLoaded;
    private bool _appLoaded;

    /// <param name="mainFrame">Whether the target is the host page, the frame inside it, or, when null, a new window.</param>
    /// <param name="url">Where it is going.</param>
    /// <param name="navigationType">`WKNavigationType`'s raw value.</param>
    public AppNavigationDecision Decide(bool? mainFrame, string? url, long navigationType)
    {
        switch (mainFrame)
        {
            case null:
                return AppNavigationDecision.Refuse;
            case true when !_hostLoaded && url == Blank:
                _hostLoaded = true;
                return AppNavigationDecision.Allow;
            case true:
                return AppNavigationDecision.Left;
            case false when _hostLoaded && !_appLoaded && url == SourceDocument:
                _appLoaded = true;
                return AppNavigationDecision.Allow;
            case false when navigationType == TypeOther && url is Blank or SourceDocument:
                return AppNavigationDecision.Refuse;
            default:
                return AppNavigationDecision.Left;
        }
    }
}
