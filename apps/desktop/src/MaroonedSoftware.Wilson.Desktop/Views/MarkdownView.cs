using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.Views;

/// <summary>An answer's Markdown, built from typed nodes as the web app's `Markdown.tsx` is, so an agent's text is never markup.</summary>
public sealed class MarkdownView : UserControl
{
    public static readonly StyledProperty<string?> TextProperty = AvaloniaProperty.Register<MarkdownView, string?>(nameof(Text));

    private const double Gap = 8;

    public string? Text
    {
        get => GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == TextProperty)
        {
            Draw();
        }
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        ActualThemeVariantChanged += (_, _) => Draw();
    }

    private void Draw() => Content = Stack(ChatMarkdown.Parse(Text ?? string.Empty));

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
                    _ = TopLevel.GetTopLevel(text)?.Launcher.LaunchUriAsync(new Uri(url));
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
