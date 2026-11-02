using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using MaroonedSoftware.Wilson.Desktop.Core.Board;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>
/// `brand/states/*.svg`, as `StateIcon.tsx` inlines them: one head, and a face that differs. The
/// source cuts the face out with a mask, so here it is stroked in `Backing`, the colour behind the icon.
/// </summary>
public sealed class StateIcon : Control
{
    public static readonly StyledProperty<CardFace?> FaceProperty = AvaloniaProperty.Register<StateIcon, CardFace?>(nameof(Face));

    public static readonly StyledProperty<IBrush?> ForegroundProperty = AvaloniaProperty.Register<StateIcon, IBrush?>(nameof(Foreground));

    public static readonly StyledProperty<IBrush?> BackingProperty = AvaloniaProperty.Register<StateIcon, IBrush?>(nameof(Backing));

    private const double Canvas = 100;

    private static readonly (Rect Bar, double Degrees)[] Fingers =
    [
        (new Rect(22, 22, 12, 30), -11),
        (new Rect(36.5, 15, 12, 37), -4),
        (new Rect(51, 17, 12, 35), 4),
        (new Rect(65.5, 24, 12, 28), 11),
    ];

    private static readonly Geometry Head = Geometry.Parse("M16 40 h68 a10 10 0 0 1 10 10 v9 a34 34 0 0 1 -34 34 h-20 a34 34 0 0 1 -34 -34 v-9 a10 10 0 0 1 10 -10 z");

    private static readonly Dictionary<CardFace, (double Width, Geometry Paths)> Faces = new()
    {
        [CardFace.Parked] = (6, Geometry.Parse("M35 63 l0 1 M65 63 l0 1 M36 78 h28")),
        [CardFace.Running] = (5.4, Geometry.Parse("M29 64 q6 -9 12 0 M59 64 q6 -9 12 0 M45.2 78 a4.8 4.8 0 1 0 9.6 0 a4.8 4.8 0 1 0 -9.6 0")),
        [CardFace.Passed] = (5.6, Geometry.Parse("M28 61 l5 5 l9 -12 M61 61 l5 5 l9 -12 M34 77 q16 12 32 0")),
        [CardFace.KickedBack] = (5.6, Geometry.Parse("M29 63 h11 M60 63 h11 M34 82 q16 -12 32 0")),
        [CardFace.NeedsHuman] = (5.4, Geometry.Parse("M29 57 q6 -7 11 0 q2 5 -5.5 8 M60 57 q6 -7 11 0 q2 5 -5.5 8 M36 80 h28")),
        [CardFace.Poisoned] = (5.4, Geometry.Parse("M29 58 l10 10 M39 58 l-10 10 M61 58 l10 10 M71 58 l-10 10 M36 80 h28")),
    };

    static StateIcon() => AffectsRender<StateIcon>(FaceProperty, ForegroundProperty, BackingProperty);

    public CardFace? Face
    {
        get => GetValue(FaceProperty);
        set => SetValue(FaceProperty, value);
    }

    public IBrush? Foreground
    {
        get => GetValue(ForegroundProperty);
        set => SetValue(ForegroundProperty, value);
    }

    public IBrush? Backing
    {
        get => GetValue(BackingProperty);
        set => SetValue(BackingProperty, value);
    }

    public override void Render(DrawingContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        if (Face is not { } face)
        {
            return;
        }

        using (context.PushTransform(Matrix.CreateScale(Bounds.Width / Canvas, Bounds.Height / Canvas)))
        {
            foreach (var (bar, degrees) in Fingers)
            {
                var turn = Matrix.CreateTranslation(-bar.Center.X, -bar.Center.Y)
                    * Matrix.CreateRotation(Math.PI * degrees / 180)
                    * Matrix.CreateTranslation(bar.Center.X, bar.Center.Y);
                using (context.PushTransform(turn))
                {
                    context.DrawRectangle(Foreground, null, new RoundedRect(bar, 6));
                }
            }

            context.DrawGeometry(Foreground, null, Head);
            var (width, paths) = Faces[face];
            context.DrawGeometry(null, new Pen(Backing, width, lineCap: PenLineCap.Round, lineJoin: PenLineJoin.Round), paths);
        }
    }
}
