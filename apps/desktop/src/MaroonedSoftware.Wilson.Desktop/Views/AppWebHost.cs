using Avalonia.Controls;
using Avalonia.Platform;
using MaroonedSoftware.Wilson.Desktop.Mac;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// Holds a web view in the window. The view is made when the control is shown and destroyed when it is
/// not, so an app's document lives no longer than its place on screen. On a platform with no native
/// windows, such as `tools/Walk`'s headless one, none is made and this draws nothing.
/// </summary>
/// <param name="make">Makes the view, ready to start, with its events already attached.</param>
public sealed class AppWebHost(Func<MacAppWebView> make) : NativeControlHost
{
    private MacAppWebView? _view;

    protected override IPlatformHandle CreateNativeControlCore(IPlatformHandle parent)
    {
        _view = make();
        _ = _view.StartAsync();
        return new PlatformHandle(_view.View, "NSView");
    }

    protected override void DestroyNativeControlCore(IPlatformHandle control)
    {
        _view?.Dispose();
        _view = null;
    }
}
