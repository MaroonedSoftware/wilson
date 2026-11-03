namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>Where a comment's card sits against its passage: just under it, and never past either edge of the draft.</summary>
public static class CommentCardPlacement
{
    public const double Gap = 6;

    public static (double Left, double Top) Place(double passageLeft, double passageBottom, double available, double cardWidth) =>
        (Math.Max(0, Math.Min(passageLeft, available - cardWidth)), passageBottom + Gap);
}
