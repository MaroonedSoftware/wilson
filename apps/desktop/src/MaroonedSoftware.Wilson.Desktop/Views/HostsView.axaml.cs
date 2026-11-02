using Avalonia.Controls;
using Avalonia.Interactivity;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class HostsView : UserControl
{
    public HostsView() => InitializeComponent();

    private void OnRemoveLeft(object? sender, RoutedEventArgs e) => ((sender as Control)?.DataContext as HostPanelViewModel)?.ForgetRemoval();
}
