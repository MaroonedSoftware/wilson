using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>Where the person writes to the chat: Enter sends, Shift+Enter starts a new line, Tab takes the suggestion.</summary>
public partial class ChatComposerView : UserControl
{
    public ChatComposerView()
    {
        InitializeComponent();

        // Tunnelled, because the box itself would take Enter as a new line and Tab as a move.
        Box.AddHandler(KeyDownEvent, KeyPressed, RoutingStrategies.Tunnel);
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        FocusBox();
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == IsVisibleProperty && IsVisible)
        {
            FocusBox();
        }
    }

    private void FocusBox() => Dispatcher.UIThread.Post(() => Box.Focus());

    /// <summary>A click anywhere in the box, such as beside a short line, lands in the text.</summary>
    private void BoxPressed(object? sender, PointerPressedEventArgs e) => Box.Focus();

    private void KeyPressed(object? sender, KeyEventArgs e)
    {
        if (DataContext is not ChatViewModel chat)
        {
            return;
        }

        if (e.Key == Key.Tab && e.KeyModifiers == KeyModifiers.None)
        {
            e.Handled = chat.TakeOffered();
            if (e.Handled)
            {
                Box.CaretIndex = chat.Composer?.Length ?? 0;
            }
        }
        else if (e.Key == Key.Enter && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            e.Handled = true;
            chat.SendCommand.Execute(null);
        }
    }
}
