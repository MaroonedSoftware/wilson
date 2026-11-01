using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>One block of an answer, as the chat draws it.</summary>
public abstract record MarkdownBlock
{
    public sealed record Heading(int Level, IReadOnlyList<MarkdownInline> Inlines) : MarkdownBlock;

    public sealed record Paragraph(IReadOnlyList<MarkdownInline> Inlines) : MarkdownBlock;

    public sealed record BlockList(bool Ordered, IReadOnlyList<IReadOnlyList<MarkdownBlock>> Items) : MarkdownBlock;

    public sealed record Code(string Text) : MarkdownBlock;

    public sealed record Quote(IReadOnlyList<MarkdownBlock> Blocks) : MarkdownBlock;
}

/// <summary>One run of text within a block.</summary>
public abstract record MarkdownInline
{
    public sealed record Text(string Value) : MarkdownInline;

    public sealed record Strong(IReadOnlyList<MarkdownInline> Inlines) : MarkdownInline;

    public sealed record Emphasis(IReadOnlyList<MarkdownInline> Inlines) : MarkdownInline;

    public sealed record Code(string Value) : MarkdownInline;

    public sealed record Link(string Url, IReadOnlyList<MarkdownInline> Inlines) : MarkdownInline;

    public sealed record Break : MarkdownInline;
}

/// <summary>
/// An answer's Markdown as plain records, for the view to build controls from. The same subset as the
/// web app's `Markdown.tsx`, and what it does not know degrades to its source text rather than vanishing.
/// </summary>
public static class ChatMarkdown
{
    public static IReadOnlyList<MarkdownBlock> Parse(string markdown)
    {
        ArgumentNullException.ThrowIfNull(markdown);

        return Blocks(Markdown.Parse(markdown), markdown);
    }

    /// <summary>Answers are written by agents, so a link opens only if it is a web address.</summary>
    public static bool CanOpen(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static List<MarkdownBlock> Blocks(IEnumerable<Block> blocks, string source) => [.. blocks.Select(block => Convert(block, source))];

    private static MarkdownBlock Convert(Block block, string source) => block switch
    {
        HeadingBlock heading => new MarkdownBlock.Heading(heading.Level, Inlines(heading.Inline, source)),
        ParagraphBlock paragraph => new MarkdownBlock.Paragraph(Inlines(paragraph.Inline, source)),
        ListBlock list => new MarkdownBlock.BlockList(list.IsOrdered, [.. list.OfType<ListItemBlock>().Select(item => (IReadOnlyList<MarkdownBlock>)Blocks(item, source))]),
        CodeBlock code => new MarkdownBlock.Code(string.Join('\n', code.Lines.Lines.Take(code.Lines.Count).Select(line => line.Slice.ToString()))),
        QuoteBlock quote => new MarkdownBlock.Quote(Blocks(quote, source)),
        _ => new MarkdownBlock.Paragraph([new MarkdownInline.Text(Source(block.Span, source))]),
    };

    private static List<MarkdownInline> Inlines(ContainerInline? container, string source)
    {
        var inlines = new List<MarkdownInline>();
        foreach (var inline in container ?? Enumerable.Empty<Inline>())
        {
            inlines.Add(inline switch
            {
                LiteralInline literal => new MarkdownInline.Text(literal.Content.ToString()),
                LineBreakInline { IsHard: true } => new MarkdownInline.Break(),
                LineBreakInline => new MarkdownInline.Text(" "),
                CodeInline code => new MarkdownInline.Code(code.Content),
                AutolinkInline link => new MarkdownInline.Link(link.Url, [new MarkdownInline.Text(link.Url)]),
                LinkInline { IsImage: false, Url: { } url } link => new MarkdownInline.Link(url, Inlines(link, source)),
                EmphasisInline { DelimiterCount: >= 2 } strong => new MarkdownInline.Strong(Inlines(strong, source)),
                EmphasisInline emphasis => new MarkdownInline.Emphasis(Inlines(emphasis, source)),
                _ => new MarkdownInline.Text(Source(inline.Span, source)),
            });
        }

        return inlines;
    }

    private static string Source(SourceSpan span, string source) =>
        span.Start >= 0 && span.End < source.Length ? source[span.Start..(span.End + 1)] : string.Empty;
}
