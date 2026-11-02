using Avalonia.Controls;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class PlanView : UserControl
{
    public PlanView()
    {
        InitializeComponent();
        DraftPreview.AddHandler(MarkdownView.PassageSelectedEvent, (_, e) => (DataContext as PlanViewModel)?.SelectPassage(e.Start, e.End, e.Text));
    }
}
