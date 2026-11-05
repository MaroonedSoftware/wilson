using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Platform;
using MaroonedSoftware.Wilson.Desktop.Mac;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// The panel the menu bar icon opens: undecorated, hung from the icon, and gone when it loses focus or another
/// application is pressed. It reads only while open.
/// </summary>
public sealed class MenuBarWindow : Window
{
    /// <summary>
    /// A press on the icon while this is open takes focus first, which closes it, then arrives as a press
    /// that would open it again. A press this soon after closing is that one.
    /// </summary>
    private static readonly TimeSpan JustClosed = TimeSpan.FromMilliseconds(250);

    private readonly MacStatusItem _item;
    private readonly MenuBarViewModel _panel;
    private DateTime _closedAt;

    public MenuBarWindow(MacStatusItem item, MenuBarViewModel panel)
    {
        _item = item;
        _panel = panel;
        Content = new MenuBarView { DataContext = panel };
        WindowDecorations = WindowDecorations.None;
        Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        Width = 300;
        Height = 400;
        SizeToContent = SizeToContent.Height;
        CanResize = false;
        ShowInTaskbar = false;
        Topmost = true;
        Title = "Wilson";
        Deactivated += (_, _) => Dismiss();
        SizeChanged += (_, _) => Place();
    }

    /// <summary>What a press on the icon does.</summary>
    public void Toggle()
    {
        if (IsVisible)
        {
            Dismiss();
        }
        else if (DateTime.UtcNow - _closedAt > JustClosed)
        {
            _panel.Shown();
            Show();
            Place();
            Activate();
            _item.Highlight(true);
            _item.WatchElsewhere(Dismiss);
        }
    }

    public void Dismiss()
    {
        if (IsVisible)
        {
            _closedAt = DateTime.UtcNow;
            _item.StopWatchingElsewhere();
            Hide();
            _panel.Hidden();
            _item.Highlight(false);
        }
    }

    /// <summary>Again on every change of size, as AppKit holds a window's bottom edge still and the top is what hangs from the icon.</summary>
    private void Place()
    {
        if (IsVisible && TryGetPlatformHandle() is IMacOSTopLevelPlatformHandle handle)
        {
            _item.PlaceUnder(handle.NSWindow);
        }
    }
}
