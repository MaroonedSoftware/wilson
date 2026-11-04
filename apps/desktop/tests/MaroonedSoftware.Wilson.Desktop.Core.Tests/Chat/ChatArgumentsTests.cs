using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class ChatArgumentsTests
{
    private static IReadOnlyList<ChatActionField> Fields(string json) => ChatArguments.Fields(JsonDocument.Parse(json).RootElement);

    [Fact]
    public void ARequestBodyIsOpenedAndItsNamesAreReadable()
    {
        var fields = Fields("""{"id":"0003","body":{"stage":"review","web_access":"none"}}""");

        Assert.Equal(
            [
                new ChatActionField("ID", "0003", ChatFieldKind.Line),
                new ChatActionField("Stage", "review", ChatFieldKind.Line),
                new ChatActionField("Web access", "none", ChatFieldKind.Line),
            ],
            fields);
    }

    [Fact]
    public void ABodyWhoseNamesClashStaysWholeSoNothingReadsTwice()
    {
        var fields = Fields("""{"id":"1","body":{"id":"2"}}""");

        Assert.Equal(["ID", "Body"], fields.Select(field => field.Label));
        Assert.Equal(ChatFieldKind.Json, fields[1].Kind);
        Assert.Contains("\"2\"", fields[1].Value, StringComparison.Ordinal);
    }

    [Fact]
    public void ABodyThatIsNotAnObjectIsAnArgumentLikeAnyOther()
    {
        Assert.Equal([new ChatActionField("Body", "text", ChatFieldKind.Line)], Fields("""{"body":"text"}"""));
    }

    [Fact]
    public void ABodyInsideABodyIsTheCardsText()
    {
        var fields = Fields("""{"body":{"body":"## Goal\n\nRead it.","stage":"parking-lot","title":"A card"}}""");

        Assert.Equal(["Stage", "Title", "Body"], fields.Select(field => field.Label));
        Assert.Equal(new ChatActionField("Body", "## Goal\n\nRead it.", ChatFieldKind.Prose), fields[2]);
    }

    [Theory]
    [InlineData(120, ChatFieldKind.Line)]
    [InlineData(121, ChatFieldKind.Prose)]
    public void LongTextIsProseEvenOnOneLine(int length, ChatFieldKind kind)
    {
        Assert.Equal(kind, Fields(JsonSerializer.Serialize(new { note = new string('a', length) }))[0].Kind);
    }

    [Fact]
    public void EveryKindOfValueIsShown()
    {
        var fields = Fields("""{"a":null,"b":true,"c":3,"d":"","e":["x"],"f":{"g":1}}""");

        Assert.Equal(["none", "true", "3", "(empty)"], fields.Take(4).Select(field => field.Value));
        Assert.All(fields.Take(4), field => Assert.True(field.IsLine));
        Assert.All(fields.Skip(4), field => Assert.True(field.IsJson));
        Assert.Contains("\"x\"", fields[4].Value, StringComparison.Ordinal);
        Assert.Contains("\"g\": 1", fields[5].Value, StringComparison.Ordinal);
    }

    [Fact]
    public void NoArgumentsMeansNoFields()
    {
        Assert.Empty(Fields("{}"));
    }

    [Fact]
    public void ArgumentsThatAreNotAnObjectAreStillShown()
    {
        Assert.Equal([new ChatActionField("Arguments", "3", ChatFieldKind.Json)], Fields("3"));
    }

    [Theory]
    [InlineData("webAccess", "Web access")]
    [InlineData("web_access", "Web access")]
    [InlineData("web-access", "Web access")]
    [InlineData("cardId", "Card ID")]
    [InlineData("id", "ID")]
    [InlineData("title", "Title")]
    [InlineData("_", "_")]
    public void NamesReadAsWords(string name, string label)
    {
        Assert.Equal(label, ChatArguments.Label(name));
    }

    [Fact]
    public void TheRawViewIsIndentedAndLeavesTextAlone()
    {
        var raw = ChatArguments.Pretty(JsonDocument.Parse("""{"body":{"title":"café <b>"}}""").RootElement);

        Assert.Contains("\n", raw, StringComparison.Ordinal);
        Assert.Contains("café <b>", raw, StringComparison.Ordinal);
    }
}
