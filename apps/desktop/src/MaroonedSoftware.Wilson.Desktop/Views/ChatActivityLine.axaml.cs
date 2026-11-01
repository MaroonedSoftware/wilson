using System.Collections;
using System.Collections.Specialized;
using Avalonia;
using Avalonia.Controls;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>What the chat ran to say what it said; hover one for its arguments. A failed one shows in the flag colour.</summary>
public partial class ChatActivityLine : UserControl
{
    public static readonly StyledProperty<IEnumerable?> ItemsProperty = AvaloniaProperty.Register<ChatActivityLine, IEnumerable?>(nameof(Items));

    public ChatActivityLine()
    {
        InitializeComponent();
        Line.IsVisible = false;
    }

    public IEnumerable? Items
    {
        get => GetValue(ItemsProperty);
        set => SetValue(ItemsProperty, value);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == ItemsProperty)
        {
            if (change.OldValue is INotifyCollectionChanged before)
            {
                before.CollectionChanged -= Changed;
            }

            if (change.NewValue is INotifyCollectionChanged after)
            {
                after.CollectionChanged += Changed;
            }

            Ran.ItemsSource = Items;
            Changed(this, EventArgs.Empty);
        }
    }

    private void Changed(object? sender, EventArgs e) => Line.IsVisible = Items?.Cast<object>().Any() == true;
}
