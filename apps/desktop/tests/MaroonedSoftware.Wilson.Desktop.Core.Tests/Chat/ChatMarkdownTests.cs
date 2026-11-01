using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class ChatMarkdownTests
{
    [Fact]
    public void ReadsTheBlocksAnAnswerUses()
    {
        var blocks = ChatMarkdown.Parse("# Title\n\nSome text.\n\n- one\n- two\n\n> said\n\n```\ncode\nmore\n```");

        Assert.Equal(2 + 3, blocks.Count);
        Assert.Equal(1, Assert.IsType<MarkdownBlock.Heading>(blocks[0]).Level);
        Assert.IsType<MarkdownBlock.Paragraph>(blocks[1]);
        Assert.Equal(2, Assert.IsType<MarkdownBlock.BlockList>(blocks[2]).Items.Count);
        Assert.Single(Assert.IsType<MarkdownBlock.Quote>(blocks[3]).Blocks);
        Assert.Equal("code\nmore", Assert.IsType<MarkdownBlock.Code>(blocks[4]).Text);
    }

    [Fact]
    public void ReadsTheInlinesWithinAParagraph()
    {
        var paragraph = Assert.IsType<MarkdownBlock.Paragraph>(Assert.Single(ChatMarkdown.Parse("**bold** *soft* `code` [site](https://example.com)")));

        Assert.IsType<MarkdownInline.Strong>(paragraph.Inlines[0]);
        Assert.IsType<MarkdownInline.Emphasis>(paragraph.Inlines[2]);
        Assert.Equal("code", Assert.IsType<MarkdownInline.Code>(paragraph.Inlines[4]).Value);
        Assert.Equal("https://example.com", Assert.IsType<MarkdownInline.Link>(paragraph.Inlines[6]).Url);
    }

    [Fact]
    public void WhatItDoesNotKnowStaysAsItsSource()
    {
        var blocks = ChatMarkdown.Parse("a\n\n---\n\nb");

        var rule = Assert.IsType<MarkdownBlock.Paragraph>(blocks[1]);
        Assert.Equal("---", Assert.IsType<MarkdownInline.Text>(Assert.Single(rule.Inlines)).Value);
    }

    [Theory]
    [InlineData("https://example.com/a", true)]
    [InlineData("http://example.com", true)]
    [InlineData("file:///etc/passwd", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("/cards/0012", false)]
    public void OnlyAWebAddressOpens(string url, bool opens) => Assert.Equal(opens, ChatMarkdown.CanOpen(url));
}
