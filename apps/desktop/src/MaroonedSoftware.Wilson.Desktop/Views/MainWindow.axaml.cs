using Avalonia.Controls;
using Avalonia.Input;
using CommunityToolkit.Mvvm.Input;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        // Avalonia's default menu has no Close item, so nothing gives the window the usual shortcut.
        KeyBindings.Add(new KeyBinding { Gesture = new KeyGesture(Key.W, KeyModifiers.Meta), Command = new RelayCommand(Close) });
    }
}
