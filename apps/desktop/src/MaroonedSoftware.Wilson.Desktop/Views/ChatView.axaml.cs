using Avalonia.Controls;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class ChatView : UserControl
{
    public ChatView()
    {
        InitializeComponent();

        // The conversation grows downward, and the newest of it is what is being read.
        Scroller.ScrollChanged += (_, change) =>
        {
            if (change.ExtentDelta.Y != 0)
            {
                Scroller.ScrollToEnd();
            }
        };
    }
}
