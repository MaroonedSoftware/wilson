using System.ComponentModel;
using Avalonia.Controls;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// Puts a web view in the page while the app runs. In code, as it is made on demand and each is its own
/// document: taking the control out of the tree is what destroys the app's page.
/// </summary>
public partial class AppView : UserControl
{
    private AppViewModel? _model;

    public AppView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_model is not null)
        {
            _model.PropertyChanged -= ModelChanged;
        }

        _model = DataContext as AppViewModel;
        if (_model is not null)
        {
            _model.PropertyChanged += ModelChanged;
        }

        Show();
    }

    private void ModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AppViewModel.Running))
        {
            Show();
        }
    }

    private void Show()
    {
        Host.Children.Clear();
        if (_model is { Running: true } model)
        {
            Host.Children.Add(new AppWebHost(model.MakeView));
        }
    }
}
