using MaroonedSoftware.Wilson.Desktop.Core.Board;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class ProjectPathsTests
{
    [Fact]
    public void RootsSitBesideTheRepo() =>
        Assert.Equal(("/srv/.worktrees/app", "/srv/.run/app"), ProjectPaths.Defaults(" app ", "/srv/app/"));

    [Theory]
    [InlineData("", "/srv/app")]
    [InlineData("app", "relative/app")]
    [InlineData("app", "")]
    public void NothingIsProposedFromHalfAnAnswer(string name, string root) =>
        Assert.Equal((string.Empty, string.Empty), ProjectPaths.Defaults(name, root));

    [Theory]
    [InlineData("/srv/app", "/srv")]
    [InlineData("/srv/app/", "/srv")]
    [InlineData("/srv", "/")]
    [InlineData("/", "/")]
    public void TheParentStopsAtTheRoot(string path, string parent) => Assert.Equal(parent, ProjectPaths.Parent(path));

    [Fact]
    public void AChildOfTheRootHasOneSlash()
    {
        Assert.Equal("/srv", ProjectPaths.Child("/", "srv"));
        Assert.Equal("/srv/app", ProjectPaths.Child("/srv", "app"));
    }

    [Fact]
    public void AFolderNamesAProject() => Assert.Equal("app", ProjectPaths.LastSegment("/srv/app"));
}
