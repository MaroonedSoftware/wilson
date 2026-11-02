using System.Text.RegularExpressions;
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

    /// <summary>`[[nnnn]]`, citing another card by id.</summary>
    public sealed record CardRef(string Id) : MarkdownInline;

    public sealed record Break : MarkdownInline;

    /// <summary>A line ending inside a paragraph: a space to read, and a newline in the source text.</summary>
    public sealed record SoftBreak : MarkdownInline;
}

/// <summary>
/// An answer's Markdown as plain records, for the view to build controls from. The same subset as the
/// web app's `Markdown.tsx`, and what it does not know degrades to its source text rather than vanishing.
/// </summary>
public static partial class ChatMarkdown
{
    public static IReadOnlyList<MarkdownBlock> Parse(string markdown)
    {
        ArgumentNullException.ThrowIfNull(markdown);

        return Blocks(Markdown.Parse(markdown), markdown);
    }

    /// <summary>
    /// The text of Markdown as read, the web app's `textContent`: no separators between blocks and no
    /// list markers. Plan comments are anchored against this, so the two clients must agree on it.
    /// </summary>
    public static string RenderedText(string markdown) => string.Concat(Parse(markdown).Select(Rendered));

    /// <summary>Answers are written by agents, so a link opens only if it is a web address.</summary>
    public static bool CanOpen(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static string Rendered(MarkdownBlock block) => block switch
    {
        MarkdownBlock.Heading heading => Rendered(heading.Inlines),
        MarkdownBlock.Paragraph paragraph => Rendered(paragraph.Inlines),
        MarkdownBlock.BlockList list => string.Concat(list.Items.SelectMany(item => item).Select(Rendered)),
        MarkdownBlock.Code code => code.Text,
        MarkdownBlock.Quote quote => string.Concat(quote.Blocks.Select(Rendered)),
        _ => string.Empty,
    };

    private static string Rendered(IEnumerable<MarkdownInline> inlines) => string.Concat(inlines.Select(inline => inline switch
    {
        MarkdownInline.Text text => text.Value,
        MarkdownInline.Code code => code.Value,
        MarkdownInline.Strong strong => Rendered(strong.Inlines),
        MarkdownInline.Emphasis emphasis => Rendered(emphasis.Inlines),
        MarkdownInline.Link link => Rendered(link.Inlines),
        MarkdownInline.CardRef reference => $"[[{reference.Id}]]",
        MarkdownInline.SoftBreak => "\n",
        _ => string.Empty,
    }));

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
                LineBreakInline => new MarkdownInline.SoftBreak(),
                CodeInline code => new MarkdownInline.Code(code.Content),
                AutolinkInline link => new MarkdownInline.Link(link.Url, [new MarkdownInline.Text(link.Url)]),
                LinkInline { IsImage: false, Url: { } url } link => new MarkdownInline.Link(url, Inlines(link, source)),
                EmphasisInline { DelimiterCount: >= 2 } strong => new MarkdownInline.Strong(Inlines(strong, source)),
                EmphasisInline emphasis => new MarkdownInline.Emphasis(Inlines(emphasis, source)),
                _ => new MarkdownInline.Text(Source(inline.Span, source)),
            });
        }

        return References(inlines);
    }

    /// <summary>
    /// `[[nnnn]]` is syntax no parser knows, so it arrives as several runs of literal brackets, which
    /// are joined before looking. Only text is read, so one inside code stays code.
    /// </summary>
    private static List<MarkdownInline> References(List<MarkdownInline> inlines)
    {
        var read = new List<MarkdownInline>();
        foreach (var run in inlines.ChunkBy(inline => inline is MarkdownInline.Text))
        {
            if (run[0] is not MarkdownInline.Text)
            {
                read.AddRange(run);
                continue;
            }

            var text = string.Concat(run.Cast<MarkdownInline.Text>().Select(part => part.Value));
            var last = 0;
            foreach (Match reference in CardReference().Matches(text))
            {
                if (reference.Index > last)
                {
                    read.Add(new MarkdownInline.Text(text[last..reference.Index]));
                }

                read.Add(new MarkdownInline.CardRef(reference.Groups[1].Value));
                last = reference.Index + reference.Length;
            }

            if (last < text.Length)
            {
                read.Add(new MarkdownInline.Text(text[last..]));
            }
        }

        return read;
    }

    private static IEnumerable<List<T>> ChunkBy<T>(this IEnumerable<T> items, Func<T, bool> key)
    {
        List<T> run = [];
        foreach (var item in items)
        {
            if (run.Count > 0 && key(run[0]) != key(item))
            {
                yield return run;
                run = [];
            }

            run.Add(item);
        }

        if (run.Count > 0)
        {
            yield return run;
        }
    }

    private static string Source(SourceSpan span, string source) =>
        span.Start >= 0 && span.End < source.Length ? source[span.Start..(span.End + 1)] : string.Empty;

    [GeneratedRegex(@"\[\[(\d+)\]\]")]
    private static partial Regex CardReference();
}
