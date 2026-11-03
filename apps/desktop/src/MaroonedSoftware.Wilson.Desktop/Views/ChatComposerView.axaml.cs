using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
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

    private async void AttachClicked(object? sender, RoutedEventArgs e)
    {
        var picker = TopLevel.GetTopLevel(this)?.StorageProvider;
        if (picker is null)
        {
            return;
        }

        var files = await picker.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Attach images",
            AllowMultiple = true,
            FileTypeFilter = [FilePickerFileTypes.ImageAll],
        });
        await AddFilesAsync(files);
    }

    /// <summary>Reads files into the box. One that cannot be read is said so, like any refusal, and the rest still come.</summary>
    private async Task AddFilesAsync(IEnumerable<IStorageItem> items)
    {
        if (DataContext is not ChatViewModel chat)
        {
            return;
        }

        foreach (var file in items.OfType<IStorageFile>())
        {
            try
            {
                await using var stream = await file.OpenReadAsync();
                if (stream.Length > ChatImages.MaxFileBytes)
                {
                    chat.Error = $"{file.Name} is too large to attach.";
                    continue;
                }

                using var bytes = new MemoryStream();
                await stream.CopyToAsync(bytes);
                chat.AddImage(file.Name, bytes.ToArray());
            }
            catch (IOException failure)
            {
                chat.Error = $"{file.Name} could not be read: {failure.Message}";
            }
            catch (UnauthorizedAccessException failure)
            {
                chat.Error = $"{file.Name} could not be read: {failure.Message}";
            }
        }
    }

    private void KeyPressed(object? sender, KeyEventArgs e)
    {
        if (DataContext is not ChatViewModel chat)
        {
            return;
        }

        if (MacTextKeys.Apply(Box, e))
        {
            e.Handled = true;
        }
        else if (e.Key == Key.Tab && e.KeyModifiers == KeyModifiers.None)
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
