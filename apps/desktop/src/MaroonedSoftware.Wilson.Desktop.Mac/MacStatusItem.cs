using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>
/// The icon in the menu bar, made directly because Avalonia's `TrayIcon` raises no click on macOS and does
/// not say where it is. Everything here runs on the UI thread, which is AppKit's main thread.
/// </summary>
public sealed class MacStatusItem : IDisposable
{
    private const double VariableLength = -1;
    private const double IconHeight = 18;
    private const double GapBelow = 4;
    private const double ScreenMargin = 8;

    /// <summary>`NSEventMaskLeftMouseDown`, `RightMouseDown` and `OtherMouseDown`.</summary>
    private const nint MouseDowns = (1 << 1) | (1 << 3) | (1 << 25);

    private static readonly Dictionary<nint, MacStatusItem> Open = [];
    private static readonly Lazy<nint> TargetClass = new(DefineTarget);
    private static readonly Lazy<nint> ClickElsewhereBlock = new(DefineClickElsewhere);
    private static Action? _clickedElsewhere;

    private readonly Action _clicked;
    private readonly nint _item;
    private readonly nint _button;
    private readonly nint _target;
    private nint _monitor;

    /// <param name="png">A template image, which macOS colours for the menu bar.</param>
    /// <param name="toolTip">What the icon says when hovered.</param>
    /// <param name="clicked">Called on each press.</param>
    public MacStatusItem(ReadOnlySpan<byte> png, string toolTip, Action clicked)
    {
        ArgumentNullException.ThrowIfNull(clicked);

        _clicked = clicked;
        var bar = ObjC.Send(ObjC.Class("NSStatusBar"), ObjC.Sel("systemStatusBar"));
        _item = ObjC.Send(ObjC.Send(bar, ObjC.Sel("statusItemWithLength:"), VariableLength), ObjC.Sel("retain"));
        _button = ObjC.Send(_item, ObjC.Sel("button"));

        var pool = ObjC.PoolPush();
        try
        {
            var data = ObjC.SendBytes(ObjC.Class("NSData"), ObjC.Sel("dataWithBytes:length:"), in MemoryMarshal.GetReference(png), png.Length);
            var image = ObjC.Send(ObjC.Send(ObjC.Class("NSImage"), ObjC.Sel("alloc")), ObjC.Sel("initWithData:"), data);
            ObjC.SendFlag(image, ObjC.Sel("setTemplate:"), true);
            ObjC.Send(image, ObjC.Sel("setSize:"), new CGPoint(IconHeight, IconHeight));
            ObjC.Send(_button, ObjC.Sel("setImage:"), image);
            ObjC.Send(image, ObjC.Sel("release"));
            ObjC.Send(_button, ObjC.Sel("setToolTip:"), ObjC.Autoreleased(toolTip));
        }
        finally
        {
            ObjC.PoolPop(pool);
        }

        _target = ObjC.Send(ObjC.Send(TargetClass.Value, ObjC.Sel("alloc")), ObjC.Sel("init"));
        Open[_target] = this;
        ObjC.Send(_button, ObjC.Sel("setTarget:"), _target);
        ObjC.Send(_button, ObjC.Sel("setAction:"), ObjC.Sel("pressed:"));
    }

    /// <summary>A real press through AppKit's target and action, which is how the walk tries it.</summary>
    public void Press() => ObjC.Send(_button, ObjC.Sel("performClick:"), (nint)0);

    /// <summary>Draws the icon pressed, as a menu's is while it is open.</summary>
    public void Highlight(bool on) => ObjC.SendFlag(_button, ObjC.Sel("highlight:"), on);

    /// <summary>
    /// Hangs a window from the icon, centred under it and kept on the icon's screen. These are AppKit's own
    /// coordinates at both ends, whatever the screen's scale, with the origin at the bottom left.
    /// </summary>
    public void PlaceUnder(nint window)
    {
        var bar = ObjC.Send(_button, ObjC.Sel("window"));
        var screen = ObjC.Send(bar, ObjC.Sel("screen"));
        if (screen == 0)
        {
            return;
        }

        // A bar window has no frame until the run loop has laid it out, and a window placed from that lands off screen.
        var icon = ObjC.SendRect(bar, ObjC.Sel("frame"));
        if (icon.Height <= 0)
        {
            return;
        }

        var visible = ObjC.SendRect(screen, ObjC.Sel("visibleFrame"));
        var width = ObjC.SendRect(window, ObjC.Sel("frame")).Width;
        var left = Math.Clamp(icon.X + ((icon.Width - width) / 2), visible.X + ScreenMargin, Math.Max(visible.X + ScreenMargin, visible.X + visible.Width - width - ScreenMargin));
        ObjC.Send(window, ObjC.Sel("setFrameTopLeftPoint:"), new CGPoint(left, icon.Y - GapBelow));
    }

    /// <summary>
    /// Calls back on a press in another application until <see cref="StopWatchingElsewhere"/>. macOS may refuse this
    /// app focus, and a window that never had focus never loses it, so focus alone cannot say when to close.
    /// </summary>
    public void WatchElsewhere(Action pressed)
    {
        StopWatchingElsewhere();
        _clickedElsewhere = pressed;
        _monitor = ObjC.Send(ObjC.Send(ObjC.Class("NSEvent"), ObjC.Sel("addGlobalMonitorForEventsMatchingMask:handler:"), MouseDowns, ClickElsewhereBlock.Value), ObjC.Sel("retain"));
    }

    public void StopWatchingElsewhere()
    {
        if (_monitor != 0)
        {
            ObjC.Send(ObjC.Class("NSEvent"), ObjC.Sel("removeMonitor:"), _monitor);
            ObjC.Send(_monitor, ObjC.Sel("release"));
            _monitor = 0;
        }

        _clickedElsewhere = null;
    }

    public void Dispose()
    {
        StopWatchingElsewhere();
        if (Open.Remove(_target))
        {
            var bar = ObjC.Send(ObjC.Class("NSStatusBar"), ObjC.Sel("systemStatusBar"));
            ObjC.Send(bar, ObjC.Sel("removeStatusItem:"), _item);
            ObjC.Send(_item, ObjC.Sel("release"));
            ObjC.Send(_target, ObjC.Sel("release"));
        }
    }

    private static unsafe nint DefineTarget() => ObjC.DefineClass(
        "WilsonStatusItemTarget",
        [],
        [("pressed:", (nint)(delegate* unmanaged<nint, nint, nint, void>)&Pressed, "v@:@")]);

    private static unsafe nint DefineClickElsewhere() => ObjC.GlobalBlock((nint)(delegate* unmanaged<nint, nint, void>)&ClickedElsewhere);

    /// <summary>Never throws, as an exception cannot cross into native code. AppKit calls a monitor on the main thread.</summary>
    [UnmanagedCallersOnly]
    private static void ClickedElsewhere(nint block, nint mouseEvent)
    {
        try
        {
            _clickedElsewhere?.Invoke();
        }
        catch (Exception failure)
        {
            Trace.WriteLine($"status item: {failure}");
        }
    }

    /// <summary>Never throws, as an exception cannot cross into native code.</summary>
    [UnmanagedCallersOnly]
    private static void Pressed(nint self, nint selector, nint sender)
    {
        try
        {
            if (Open.TryGetValue(self, out var item))
            {
                item._clicked();
            }
        }
        catch (Exception failure)
        {
            Trace.WriteLine($"status item: {failure}");
        }
    }
}
