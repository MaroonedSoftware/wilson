using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.VisualTree;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// A tile stays a button, and becomes a drag only past a few pixels of movement, so a click still
/// opens its card. Capturing the pointer at that moment is what takes the press away from the button.
/// The drag is drawn here and is animation, not state: what a drop means is `BoardRules.Drop`.
/// </summary>
public partial class BoardView : UserControl
{
    private const double Threshold = 8;
    private const double Edge = 48;
    private const double EdgeStep = 24;

    private BoardTile? _held;
    private Point _from;
    private bool _dragging;

    public BoardView()
    {
        InitializeComponent();
        AddHandler(PointerPressedEvent, OnPressed, RoutingStrategies.Tunnel);
        AddHandler(PointerMovedEvent, OnMoved, RoutingStrategies.Tunnel);
        AddHandler(PointerReleasedEvent, OnReleased, RoutingStrategies.Tunnel);
        PointerCaptureLost += OnCaptureLost;
    }

    private BoardViewModel? Board => DataContext as BoardViewModel;

    private void OnPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed
            && e.Source is Visual source
            && (source as Button ?? source.FindAncestorOfType<Button>()) is { DataContext: BoardTile tile } button
            && button.Classes.Contains("tile"))
        {
            _held = tile;
            _from = e.GetPosition(this);
        }
    }

    private void OnMoved(object? sender, PointerEventArgs e)
    {
        if (_held is not { } tile || Board is not { } board)
        {
            return;
        }

        var at = e.GetPosition(this);
        if (!_dragging)
        {
            if (Point.Distance(at, _from) < Threshold)
            {
                return;
            }

            _dragging = true;
            e.Pointer.Capture(this);
            board.BeginDrag(tile);
            GhostId.Text = tile.Card.Id;
            GhostTitle.Text = tile.Card.Title;
            Ghost.IsVisible = true;
        }

        Canvas.SetLeft(Ghost, at.X - (Ghost.Width / 2));
        Canvas.SetTop(Ghost, at.Y - 16);
        Nudge(at);
        board.Hover(tile, Over(at));
        e.Handled = true;
    }

    private void OnReleased(object? sender, PointerReleasedEventArgs e)
    {
        var tile = _held;
        var dragged = _dragging;
        Reset();
        if (dragged && tile is not null && Board is { } board)
        {
            e.Handled = true;
            var over = Over(e.GetPosition(this));
            e.Pointer.Capture(null);
            _ = board.EndDragAsync(tile, over);
        }
    }

    /// <summary>The app losing the pointer mid-drag is a drop on nothing.</summary>
    private void OnCaptureLost(object? sender, PointerCaptureLostEventArgs e)
    {
        var tile = _held;
        var dragged = _dragging;
        Reset();
        if (dragged && tile is not null && Board is { } board)
        {
            _ = board.EndDragAsync(tile, null);
        }
    }

    private void Reset()
    {
        _held = null;
        _dragging = false;
        Ghost.IsVisible = false;
    }

    /// <summary>A board wider than the window scrolls as a held card reaches its edge.</summary>
    private void Nudge(Point at)
    {
        var x = at.X - Scroller.Bounds.X;
        var step = x < Edge ? -EdgeStep : x > Scroller.Bounds.Width - Edge ? EdgeStep : 0;
        if (step != 0)
        {
            Scroller.Offset = Scroller.Offset.WithX(Math.Max(0, Scroller.Offset.X + step));
        }
    }

    /// <summary>The topmost card or column under a point, as `BoardRules.Drop` reads either.</summary>
    private string? Over(Point at)
    {
        foreach (var visual in this.GetVisualsAt(at))
        {
            switch ((visual as StyledElement)?.DataContext)
            {
                case BoardTile tile:
                    return tile.Card.Id;
                case BoardColumn column:
                    return column.Name;
                default:
                    break;
            }
        }

        return null;
    }
}
