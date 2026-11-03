using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.Core.Planning;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

public partial class PlanView : UserControl
{
    private const double BelowCard = 12;

    private PlanViewModel? _plan;

    public PlanView()
    {
        InitializeComponent();
        DraftPreview.AddHandler(MarkdownView.PassageSelectedEvent, (_, e) => (DataContext as PlanViewModel)?.SelectPassage(e.Start, e.End, e.Text));
        DraftPreview.AddHandler(MarkdownView.PassagePressedEvent, (_, e) => (DataContext as PlanViewModel)?.PressPassage(e.Offset));
        DraftPreview.SizeChanged += (_, _) => PlaceCard();

        // Tunnelled, because the box itself would take Enter as a new line.
        CommentBox.AddHandler(KeyDownEvent, CommentKeyPressed, RoutingStrategies.Tunnel);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);

        if (_plan is not null)
        {
            _plan.PropertyChanged -= PlanChanged;
        }

        _plan = DataContext as PlanViewModel;
        if (_plan is not null)
        {
            _plan.PropertyChanged += PlanChanged;
        }
    }

    private void PlanChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(PlanViewModel.CardAnchor) or nameof(PlanViewModel.Marks))
        {
            // After layout: the marks redraw the text this measures.
            Dispatcher.UIThread.Post(PlaceCard, DispatcherPriority.Loaded);
        }

        if (e.PropertyName is nameof(PlanViewModel.Quote) && _plan?.Quote is not null)
        {
            Dispatcher.UIThread.Post(() => CommentBox.Focus(), DispatcherPriority.Loaded);
        }
    }

    /// <summary>Beside its passage, inside the draft's own scroll so the two move together. The canvas grows to hold a card past the end of the text.</summary>
    private void PlaceCard()
    {
        if (_plan?.CardAnchor is not { } anchor || DraftPreview.RangeBounds(anchor.Start, anchor.End) is not { } passage)
        {
            if (_plan?.CardAnchor is null)
            {
                Overlay.MinHeight = 0;
            }

            return;
        }

        var (left, top) = CommentCardPlacement.Place(passage.Left, passage.Bottom, Overlay.Bounds.Width, CommentCard.Width);
        Canvas.SetLeft(CommentCard, left);
        Canvas.SetTop(CommentCard, top);
        CommentCard.Measure(new Size(CommentCard.Width, double.PositiveInfinity));
        Overlay.MinHeight = top + CommentCard.DesiredSize.Height + BelowCard;
        Dispatcher.UIThread.Post(() => CommentCard.BringIntoView(), DispatcherPriority.Loaded);
    }

    private void CommentKeyPressed(object? sender, KeyEventArgs e)
    {
        if (_plan is null)
        {
            return;
        }

        if (MacTextKeys.Apply(CommentBox, e))
        {
            e.Handled = true;
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            _plan.CancelCommentCommand.Execute(null);
        }
        else if (e.Key == Key.Enter && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            e.Handled = true;
            _plan.AddCommentCommand.Execute(null);
        }
    }
}
