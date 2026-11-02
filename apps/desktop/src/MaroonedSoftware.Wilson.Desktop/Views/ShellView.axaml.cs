using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class ShellView : UserControl
{
    /// <summary>How far one arrow-key press resizes the dock.</summary>
    private const int KeyStep = 24;

    private bool _resizing;

    public ShellView()
    {
        InitializeComponent();
        AddHandler(MarkdownView.CardReferencedEvent, (_, e) => _ = (DataContext as ShellViewModel)?.OpenReferenceAsync(e.Id));
        Handle(RightHandle);
        Handle(BottomHandle);
    }

    private ShellViewModel? Shell => DataContext as ShellViewModel;

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);

        // On the window, as nothing need have the focus for the shortcut to work.
        TopLevel.GetTopLevel(this)?.KeyBindings.Add(new KeyBinding
        {
            Gesture = new KeyGesture(Key.J, KeyModifiers.Meta),
            Command = new RelayCommand(() => Shell?.ToggleDock()),
        });
    }

    private void Handle(Border handle)
    {
        handle.PointerPressed += (_, e) =>
        {
            _resizing = true;
            e.Pointer.Capture(handle);
            e.Handled = true;
        };
        handle.PointerMoved += (_, e) =>
        {
            if (_resizing)
            {
                var at = e.GetPosition(this);
                Size(handle, (int)(Bounds.Width - at.X), (int)(Bounds.Height - at.Y));
            }
        };
        handle.PointerReleased += (_, e) =>
        {
            _resizing = false;
            e.Pointer.Capture(null);
            Shell?.KeepDockSize();
        };
        handle.KeyDown += (_, e) => Arrow(handle, e);
    }

    private void Size(Border handle, int width, int height)
    {
        if (handle == RightHandle)
        {
            Shell?.ResizeDock(width: width);
        }
        else
        {
            Shell?.ResizeDock(height: height);
        }
    }

    private void Arrow(Border handle, KeyEventArgs e)
    {
        var right = handle == RightHandle;
        var step = e.Key == (right ? Key.Left : Key.Up) ? KeyStep : e.Key == (right ? Key.Right : Key.Down) ? -KeyStep : 0;
        if (step != 0 && Shell is { } shell)
        {
            Size(handle, shell.Dock.Width + step, shell.Dock.Height + step);
            shell.KeepDockSize();
            e.Handled = true;
        }
    }
}
