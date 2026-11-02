using Avalonia.Controls;
using Avalonia.Input;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// The macOS text shortcuts <see cref="TextBox"/> leaves out, each said in the keys it does know, so that
/// its own undo and line wrapping still apply. Ctrl+T and Ctrl+Y are not here: they need a kill ring.
/// </summary>
public static class MacTextKeys
{
    /// <summary>Carries out a shortcut on the box. False when the key is not one of them.</summary>
    public static bool Apply(TextBox box, KeyEventArgs e)
    {
        ArgumentNullException.ThrowIfNull(box);
        ArgumentNullException.ThrowIfNull(e);

        switch (e.KeyModifiers, e.Key)
        {
            case (KeyModifiers.Meta, Key.Up):
                Press(box, Key.Home, KeyModifiers.Meta);
                return true;
            case (KeyModifiers.Meta, Key.Down):
                Press(box, Key.End, KeyModifiers.Meta);
                return true;
            case (KeyModifiers.Meta | KeyModifiers.Shift, Key.Up):
                Press(box, Key.Home, KeyModifiers.Meta | KeyModifiers.Shift);
                return true;
            case (KeyModifiers.Meta | KeyModifiers.Shift, Key.Down):
                Press(box, Key.End, KeyModifiers.Meta | KeyModifiers.Shift);
                return true;
            case (KeyModifiers.Meta, Key.Back):
                DeleteTo(box, Key.Home, Key.Back);
                return true;
            case (KeyModifiers.Meta, Key.Delete):
            case (KeyModifiers.Control, Key.K):
                DeleteTo(box, Key.End, Key.Delete);
                return true;
            case (KeyModifiers.Control, Key.A):
                Press(box, Key.Home);
                return true;
            case (KeyModifiers.Control, Key.E):
                Press(box, Key.End);
                return true;
            case (KeyModifiers.Control, Key.B):
                Press(box, Key.Left);
                return true;
            case (KeyModifiers.Control, Key.F):
                Press(box, Key.Right);
                return true;
            case (KeyModifiers.Control, Key.P):
                Press(box, Key.Up);
                return true;
            case (KeyModifiers.Control, Key.N):
                Press(box, Key.Down);
                return true;
            case (KeyModifiers.Control, Key.D):
                Press(box, Key.Delete);
                return true;
            case (KeyModifiers.Control, Key.H):
                Press(box, Key.Back);
                return true;
            default:
                return false;
        }
    }

    /// <summary>Removes a selection, or else from the caret to the edge of the line, or else what is next to it there.</summary>
    private static void DeleteTo(TextBox box, Key edge, Key delete)
    {
        if (box.SelectionStart == box.SelectionEnd)
        {
            Press(box, edge, KeyModifiers.Shift);
        }

        Press(box, delete);
    }

    private static void Press(TextBox box, Key key, KeyModifiers modifiers = KeyModifiers.None) =>
        box.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Source = box, Key = key, KeyModifiers = modifiers });
}
