using Avalonia.Controls;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class ShellView : UserControl
{
    public ShellView()
    {
        InitializeComponent();
        AddHandler(MarkdownView.CardReferencedEvent, (_, e) => _ = (DataContext as ShellViewModel)?.OpenReferenceAsync(e.Id));
    }
}
