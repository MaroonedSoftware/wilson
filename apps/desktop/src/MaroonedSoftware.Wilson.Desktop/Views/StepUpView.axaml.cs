using Avalonia.Controls;
using Avalonia.Threading;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class StepUpView : UserControl
{
    public StepUpView()
    {
        InitializeComponent();
        AttachedToVisualTree += (_, _) => Dispatcher.UIThread.Post(() => PasswordBox.Focus());
    }
}
