using Avalonia.Controls;
using Avalonia.Interactivity;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class PlanView : UserControl
{
    public PlanView() => InitializeComponent();

    private void CommentOnSelection(object? sender, RoutedEventArgs e)
    {
        if (DataContext is PlanViewModel plan && DraftBox.SelectedText is { Length: > 0 } selected)
        {
            plan.Quote = selected;
        }
    }
}
