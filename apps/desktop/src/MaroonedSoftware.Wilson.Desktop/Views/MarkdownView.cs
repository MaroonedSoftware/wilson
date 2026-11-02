using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.VisualTree;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>A `[[nnnn]]` pressed, for the shell to open.</summary>
public sealed class CardReferencedEventArgs(RoutedEvent routedEvent, string id) : RoutedEventArgs(routedEvent)
{
    public string Id => id;
}

/// <summary>A stretch of `ChatMarkdown.RenderedText` to mark.</summary>
public sealed record MarkdownMark(int Start, int End, bool Quiet);

/// <summary>A passage selected, as offsets into `ChatMarkdown.RenderedText`.</summary>
public sealed class PassageSelectedEventArgs(RoutedEvent routedEvent, int start, int end, string text) : RoutedEventArgs(routedEvent)
{
    public int Start => start;

    public int End => end;

    public string Text => text;
}

/// <summary>An answer's Markdown, built from typed nodes as the web app's `Markdown.tsx` is, so an agent's text is never markup.</summary>
public sealed class MarkdownView : UserControl
{
    public static readonly StyledProperty<string?> TextProperty = AvaloniaProperty.Register<MarkdownView, string?>(nameof(Text));

    public static readonly RoutedEvent<CardReferencedEventArgs> CardReferencedEvent =
        RoutedEvent.Register<MarkdownView, CardReferencedEventArgs>("CardReferenced", RoutingStrategies.Bubble);

    public static readonly StyledProperty<IReadOnlyList<MarkdownMark>?> MarksProperty = AvaloniaProperty.Register<MarkdownView, IReadOnlyList<MarkdownMark>?>(nameof(Marks));

    public static readonly RoutedEvent<PassageSelectedEventArgs> PassageSelectedEvent =
        RoutedEvent.Register<MarkdownView, PassageSelectedEventArgs>("PassageSelected", RoutingStrategies.Bubble);

    private const double Gap = 8;
    private const string CardScheme = "wilson-card:";

    public MarkdownView() => AddHandler(PointerReleasedEvent, OnReleased, RoutingStrategies.Bubble, handledEventsToo: true);

    public string? Text
    {
        get => GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    public IReadOnlyList<MarkdownMark>? Marks
    {
        get => GetValue(MarksProperty);
        set => SetValue(MarksProperty, value);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == TextProperty || change.Property == MarksProperty)
        {
            Draw();
        }
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        ActualThemeVariantChanged += (_, _) => Draw();
    }

    private void Draw()
    {
        Content = Stack(ChatMarkdown.Parse(Text ?? string.Empty));
        if (Marks is { Count: > 0 } marks)
        {
            Mark(marks);
        }
    }

    /// <summary>Runs in reading order, each with where it starts. A hard break counts for nothing, as in the rendered text.</summary>
    private IEnumerable<(SelectableTextBlock Block, int Start)> Blocks()
    {
        var at = 0;
        foreach (var block in Words(Content as Control))
        {
            yield return (block, at);
            at += RenderedLength(block);
        }
    }

    private static IEnumerable<SelectableTextBlock> Words(Control? control) => control switch
    {
        SelectableTextBlock block => [block],
        Panel panel => panel.Children.SelectMany(Words),
        Decorator { Child: { } child } => Words(child),
        _ => [],
    };

    private static int RenderedLength(SelectableTextBlock block) =>
        block.Inlines is { Count: > 0 } inlines ? inlines.Sum(inline => inline is Run run ? run.Text?.Length ?? 0 : 0) : block.Text?.Length ?? 0;

    /// <summary>A selection, read back as offsets into the whole text. A press that selects nothing says nothing.</summary>
    private void OnReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (e.Source is not Visual source || (source as SelectableTextBlock ?? source.FindAncestorOfType<SelectableTextBlock>()) is not { } block
            || block.SelectedText is not { Length: > 0 } selected)
        {
            return;
        }

        foreach (var (candidate, start) in Blocks())
        {
            if (candidate == block)
            {
                var from = Math.Min(block.SelectionStart, block.SelectionEnd);
                RaiseEvent(new PassageSelectedEventArgs(PassageSelectedEvent, start + from, start + from + selected.Length, selected));
                return;
            }
        }
    }

    /// <summary>Splits runs at the marks. The links' offsets stand, as the text itself does not change.</summary>
    private void Mark(IReadOnlyList<MarkdownMark> marks)
    {
        foreach (var (block, start) in Blocks().ToList())
        {
            if (block.Inlines is not { Count: > 0 } inlines)
            {
                continue;
            }

            var at = start;
            foreach (var inline in inlines.ToList())
            {
                if (inline is not Run { Text: { Length: > 0 } text } run)
                {
                    continue;
                }

                var end = at + text.Length;
                var within = marks.Where(mark => mark.Start < end && mark.End > at).OrderBy(mark => mark.Start).ToList();
                if (within.Count > 0)
                {
                    var place = inlines.IndexOf(run);
                    inlines.RemoveAt(place);
                    foreach (var piece in Pieces(text, at, within))
                    {
                        inlines.Insert(place++, Copy(run, piece.Text, piece.Mark));
                    }
                }

                at = end;
            }
        }
    }

    private static IEnumerable<(string Text, MarkdownMark? Mark)> Pieces(string text, int at, IReadOnlyList<MarkdownMark> marks)
    {
        var from = 0;
        foreach (var mark in marks)
        {
            var start = Math.Clamp(mark.Start - at, from, text.Length);
            var end = Math.Clamp(mark.End - at, start, text.Length);
            if (start > from)
            {
                yield return (text[from..start], null);
            }

            if (end > start)
            {
                yield return (text[start..end], mark);
            }

            from = end;
        }

        if (from < text.Length)
        {
            yield return (text[from..], null);
        }
    }

    private static Run Copy(Run run, string text, MarkdownMark? mark)
    {
        var copy = new Run(text) { FontWeight = run.FontWeight, FontStyle = run.FontStyle, TextDecorations = run.TextDecorations, Background = run.Background };
        if (run.IsSet(TextElement.FontFamilyProperty))
        {
            copy.FontFamily = run.FontFamily;
            copy.FontSize = run.FontSize;
        }

        if (mark is not null)
        {
            copy.Background = Resource<IBrush>(mark.Quiet ? "Line" : "Marked");
        }

        return copy;
    }

    private static StackPanel Stack(IEnumerable<MarkdownBlock> blocks)
    {
        var stack = new StackPanel { Spacing = Gap };
        stack.Children.AddRange(blocks.Select(Draw));
        return stack;
    }

    private static Control Draw(MarkdownBlock block) => block switch
    {
        MarkdownBlock.Heading heading => Heading(heading),
        MarkdownBlock.Paragraph paragraph => Written(paragraph.Inlines),
        MarkdownBlock.BlockList list => BlockList(list),
        MarkdownBlock.Code code => Code(code.Text),
        MarkdownBlock.Quote quote => Quote(quote),
        _ => throw new InvalidOperationException($"no drawing for {block.GetType().Name}"),
    };

    private static SelectableTextBlock Heading(MarkdownBlock.Heading heading)
    {
        var text = Written(heading.Inlines);
        text.FontFamily = Resource<FontFamily>("Serif")!;
        text.FontSize = heading.Level == 1 ? 22 : heading.Level == 2 ? 18 : 16;
        text.LineHeight = double.NaN;
        return text;
    }

    private static SelectableTextBlock Written(IReadOnlyList<MarkdownInline> inlines)
    {
        var text = new SelectableTextBlock { Classes = { "answer" }, Inlines = [] };
        var links = new List<(int Start, int End, string Url)>();
        foreach (var inline in inlines)
        {
            Add(text.Inlines!, links, inline, FontWeight.Normal, FontStyle.Normal);
        }

        if (links.Count > 0)
        {
            Follow(text, links);
        }

        return text;
    }

    /// <summary>
    /// A link is underlined text rather than a button in the line, which would break the line's height
    /// and could not wrap. So a press finds its own link, and a drag across one is a selection.
    /// </summary>
    private static void Follow(SelectableTextBlock text, List<(int Start, int End, string Url)> links)
    {
        string? At(PointerEventArgs e)
        {
            var position = text.TextLayout.HitTestPoint(e.GetPosition(text)).TextPosition;
            return links.FirstOrDefault(link => position >= link.Start && position < link.End).Url;
        }

        text.PointerMoved += (_, e) => text.Cursor = At(e) is null ? Cursor.Default : new Cursor(StandardCursorType.Hand);
        text.AddHandler(
            PointerReleasedEvent,
            (_, e) =>
            {
                if (text.SelectionStart == text.SelectionEnd && At(e) is { } url)
                {
                    if (url.StartsWith(CardScheme, StringComparison.Ordinal))
                    {
                        text.RaiseEvent(new CardReferencedEventArgs(CardReferencedEvent, url[CardScheme.Length..]));
                    }
                    else
                    {
                        _ = TopLevel.GetTopLevel(text)?.Launcher.LaunchUriAsync(new Uri(url));
                    }
                }
            },
            RoutingStrategies.Bubble,
            handledEventsToo: true);
    }

    private static void Add(InlineCollection into, List<(int Start, int End, string Url)> links, MarkdownInline inline, FontWeight weight, FontStyle style)
    {
        switch (inline)
        {
            case MarkdownInline.Text text:
                into.Add(new Run(text.Value) { FontWeight = weight, FontStyle = style });
                break;
            case MarkdownInline.Strong strong:
                AddAll(into, links, strong.Inlines, FontWeight.Bold, style);
                break;
            case MarkdownInline.Emphasis emphasis:
                AddAll(into, links, emphasis.Inlines, weight, FontStyle.Italic);
                break;
            case MarkdownInline.Code code:
                into.Add(new Run(code.Value) { FontFamily = Resource<FontFamily>("Mono")!, FontSize = 13, Background = Resource<IBrush>("Panel") });
                break;
            case MarkdownInline.Break:
                into.Add(new LineBreak());
                break;
            case MarkdownInline.CardRef reference:
                var from = Length(into);
                var cited = $"[[{reference.Id}]]";
                into.Add(new Run(cited) { FontWeight = weight, FontStyle = style, TextDecorations = TextDecorations.Underline });
                links.Add((from, from + cited.Length, CardScheme + reference.Id));
                break;
            case MarkdownInline.Link link when ChatMarkdown.CanOpen(link.Url):
                var start = Length(into);
                var run = new Run(Plain(link.Inlines)) { FontWeight = weight, FontStyle = style, TextDecorations = TextDecorations.Underline };
                into.Add(run);
                links.Add((start, start + run.Text!.Length, link.Url));
                break;
            case MarkdownInline.Link link:
                AddAll(into, links, link.Inlines, weight, style);
                break;
            default:
                break;
        }
    }

    private static void AddAll(InlineCollection into, List<(int Start, int End, string Url)> links, IEnumerable<MarkdownInline> inlines, FontWeight weight, FontStyle style)
    {
        foreach (var inline in inlines)
        {
            Add(into, links, inline, weight, style);
        }
    }

    private static int Length(InlineCollection inlines) => inlines.Sum(inline => inline is Run run ? run.Text?.Length ?? 0 : 1);

    private static string Plain(IEnumerable<MarkdownInline> inlines) => string.Concat(inlines.Select(inline => inline switch
    {
        MarkdownInline.Text text => text.Value,
        MarkdownInline.Code code => code.Value,
        MarkdownInline.Strong strong => Plain(strong.Inlines),
        MarkdownInline.Emphasis emphasis => Plain(emphasis.Inlines),
        MarkdownInline.Link link => Plain(link.Inlines),
        MarkdownInline.CardRef reference => $"[[{reference.Id}]]",
        _ => " ",
    }));

    private static StackPanel BlockList(MarkdownBlock.BlockList list)
    {
        var items = new StackPanel { Spacing = 4 };
        foreach (var (item, index) in list.Items.Select((item, index) => (item, index)))
        {
            var row = new DockPanel();
            var marker = new TextBlock
            {
                Text = list.Ordered ? $"{index + 1}." : "•",
                FontSize = 14,
                LineHeight = 21,
                Width = 20,
            };
            DockPanel.SetDock(marker, Dock.Left);
            row.Children.Add(marker);
            row.Children.Add(Stack(item));
            items.Children.Add(row);
        }

        return items;
    }

    private static Border Code(string text) => new()
    {
        Classes = { "codeblock" },
        Child = new SelectableTextBlock { Classes = { "mono" }, Text = text },
    };

    private static Border Quote(MarkdownBlock.Quote quote) => new()
    {
        BorderBrush = Resource<IBrush>("Line"),
        BorderThickness = new Thickness(3, 0, 0, 0),
        Padding = new Thickness(12, 0, 0, 0),
        HorizontalAlignment = HorizontalAlignment.Stretch,
        Child = Stack(quote.Blocks),
    };

    private static T? Resource<T>(string key)
        where T : class =>
        Application.Current!.TryGetResource(key, Application.Current.ActualThemeVariant, out var value) ? value as T : null;
}
