using MaroonedSoftware.Wilson.Desktop.Core.Diff;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Diff;

public class PatchTests
{
    private const string Sample = """
        diff --git a/a.txt b/a.txt
        index 1234..5678 100644
        --- a/a.txt
        +++ b/a.txt
        @@ -10,3 +10,4 @@ function
         kept
        -gone
        +new one
        +new two
         kept too
        \ No newline at end of file

        """;

    [Fact]
    public void TheFileHeaderIsDropped_AndTheFirstLineIsTheHunk() =>
        Assert.Equal(PatchLineKind.Hunk, Patch.Parse(Sample)[0].Kind);

    [Fact]
    public void EachSideCountsOnlyItsOwnLines()
    {
        var lines = Patch.Parse(Sample);

        Assert.Equal(new PatchLine(PatchLineKind.Context, "kept", 10, 10), lines[1]);
        Assert.Equal(new PatchLine(PatchLineKind.Removed, "gone", 11), lines[2]);
        Assert.Equal(new PatchLine(PatchLineKind.Added, "new one", null, 11), lines[3]);
        Assert.Equal(new PatchLine(PatchLineKind.Added, "new two", null, 12), lines[4]);
        Assert.Equal(new PatchLine(PatchLineKind.Context, "kept too", 12, 13), lines[5]);
    }

    [Fact]
    public void GitsRemarkIsANote() => Assert.Equal(PatchLineKind.Note, Patch.Parse(Sample)[6].Kind);

    [Fact]
    public void AHunkWithOneLineOmitsItsCount() =>
        Assert.Equal(7, Patch.Parse("@@ -7 +7 @@\n-a\n+b")[1].OldNumber);

    [Fact]
    public void ALineOfDashesInsideAHunkIsContent_NotAHeader() =>
        Assert.Equal(new PatchLine(PatchLineKind.Removed, "-- a sql comment", 1), Patch.Parse("@@ -1 +1 @@\n--- a sql comment")[1]);

    [Fact]
    public void ABinaryFileSaysSo() => Assert.Equal(PatchLineKind.Note, Assert.Single(Patch.Parse("Binary files a/x and b/x differ")).Kind);

    [Fact]
    public void AnEmptyPatchIsNoLines() => Assert.Empty(Patch.Parse(string.Empty));
}
