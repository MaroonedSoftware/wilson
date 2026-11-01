using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class SignInView : UserControl
{
    private SignInViewModel? _signIn;

    public SignInView()
    {
        InitializeComponent();

        RevealToggle.IsCheckedChanged += (_, _) => PasswordBox.RevealPassword = RevealToggle.IsChecked is true;
        DataContextChanged += OnDataContextChanged;
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        Ready();
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_signIn is not null)
        {
            _signIn.PropertyChanged -= OnSignInChanged;
        }

        _signIn = DataContext as SignInViewModel;

        if (_signIn is not null)
        {
            _signIn.PropertyChanged += OnSignInChanged;
        }
    }

    private void OnSignInChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(SignInViewModel.Step))
        {
            Ready();
        }
    }

    /// <summary>The caret in the step's first box, and the password back out of sight.</summary>
    /// <remarks>Posted, because a control still hidden when the step changes refuses focus and says nothing.</remarks>
    private void Ready()
    {
        RevealToggle.IsChecked = false;
        Dispatcher.UIThread.Post(
            () =>
            {
                if (_signIn is { } signIn)
                {
                    (signIn.Finding ? AddressBox : signIn.NeedsCode ? CodeBox : EmailBox).Focus();
                }
            },
            DispatcherPriority.Loaded);
    }
}
